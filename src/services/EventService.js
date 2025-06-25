const Event = require("../models/EventModel");
const User = require("../models/UserModel");
const Category = require("../models/CategoryModel");
const Conversation = require("../models/ConversationModel");
const {
  deleteFromCloudinary,
  extractPublicId,
} = require("../utils/UploadImage");
const notificationService = require("../services/NotificationService");
const Ticket = require("../models/TicketModel");
const TransferTicket = require("../models/TransferTicketModel");
const UserService = require("./UserService");

class EventService {
  static async createEvent(eventData) {
    try {
      console.log("Input eventData:", JSON.stringify(eventData, null, 2));

      // Chuyển đổi thời gian từ GMT+7 sang UTC khi lưu vào database
      const GMT7_OFFSET = 7 * 60 * 60 * 1000;
      if (eventData.date) {
        const localDate = new Date(eventData.date);
        const utcDate = new Date(localDate.getTime() - GMT7_OFFSET);
        eventData.date = utcDate;

        console.log("Event time conversion:", {
          inputDate: localDate.toISOString(),
          storedDate: utcDate.toISOString(),
          localTimeGMT7: new Date(utcDate.getTime() + GMT7_OFFSET).toISOString()
        });
      }

      // Validate date (sử dụng thời gian hiện tại theo GMT+7)
      const currentTimeGMT7 = new Date(Date.now());
      if (eventData.date < currentTimeGMT7) {
        throw new Error("Event date must be in the future");
      }

      // Kiểm tra collaborators có role event_creator
      if (eventData.collaborators?.length) {
        const collaborators = await User.find({
          _id: { $in: eventData.collaborators },
          role: "event_creator",
        });

        if (collaborators.length !== eventData.collaborators.length) {
          throw new Error("Some collaborators are not event creators");
        }
      }

      // Validate categoryId
      const category = await Category.findById(eventData.categoryId);
      if (!category) {
        throw new Error("Category not found");
      }

      // Validate price and maxAttendees
      if (eventData.price < 0) {
        throw new Error("Price must be positive");
      }
      if (eventData.maxAttendees < 0) {
        throw new Error("Maximum attendees must be positive");
      }

      const newConversation = new Conversation({
        members: [],
        title: eventData.name,
      });
      const savedConversation = await newConversation.save();

      // Liên kết conversation với eventData
      eventData.conversation = savedConversation._id;

      const event = new Event(eventData);

      // Validate thủ công
      const validationError = event.validateSync();
      if (validationError) {
        console.log("Validation errors:", validationError.errors);
        throw validationError;
      }

      console.log("Event before save:", event);
      const savedEvent = await event.save();

      // Thêm eventId vào mảng eventsCreated của user
      await User.findByIdAndUpdate(
        eventData.createdBy,
        {
          $push: { eventsCreated: savedEvent._id }
        }
      );

      // Nếu có collaborators, thêm eventId vào mảng eventsCreated của họ
      if (eventData.collaborators?.length) {
        await User.updateMany(
          { _id: { $in: eventData.collaborators } },
          {
            $push: { eventsCreated: savedEvent._id }
          }
        );
      }

      const users = await User.find({
        role: { $in: ["ticket_buyer", "admin"] },
      });

      const tokens = users
        .flatMap((user) => user.fcmTokens)
        .filter(Boolean);

      if (tokens.length) {
        const title = "New Event Created!";
        const body = `Check out the new event: ${eventData.name}`;
        const data = {
          type: "new_event",
          eventId: savedEvent._id.toString(),
        };

        await notificationService.sendNotification(tokens, title, body, data);

        for (const user of users) {
          await notificationService.saveNotification(
            user._id,
            "new_event",
            title,
            body,
            data
          );
        }
      }

      return savedEvent;
    } catch (error) {
      console.log("Detailed error:", {
        message: error.message,
        errors: error.errors,
        code: error.code,
        details: error.errInfo?.details,
      });
      throw error;
    }
  }

  static async getEvents(filters = {}) {
    try {
      const query = { isDeleted: false };

      // Chuyển đổi filter date sang UTC nếu có
      if (filters.date) {
        const GMT7_OFFSET = 7 * 60 * 60 * 1000;
        const localDate = new Date(filters.date);
        query.date = new Date(localDate.getTime() - GMT7_OFFSET);
      }

      // Nếu lọc các event trong tương lai, sử dụng thời gian GMT+7
      if (filters.isAfter) {
        const GMT7_OFFSET = 7 * 60 * 60 * 1000;
        const currentTimeGMT7 = new Date(Date.now() + GMT7_OFFSET);
        query.date = { $gt: new Date(currentTimeGMT7.getTime() - GMT7_OFFSET) };
      }

      if (filters.status) query.status = filters.status;
      if (filters.categoryId) query.categoryId = filters.categoryId;
      if (filters.createdBy) query.createdBy = filters.createdBy;

      let sortOptions = { createdAt: -1 };
      if (filters.sortBy) {
        switch (filters.sortBy) {
          case "date":
            sortOptions = { date: -1 };
            break;
          case "sold":
            sortOptions = { ticketsSold: -1 };
            break;
          case "price":
            sortOptions = { price: 1 };
            break;
          default:
            sortOptions = { createdAt: -1 };
            break;
        }
      }

      return await Event.find(query)
        .sort(sortOptions) // Sắp xếp theo thời gian tạo mới nhất
        .populate("categoryId", "name")
        .populate("createdBy", "name")
        .populate("conversation", "_id title")
        .populate("collaborators", "_id name")
        .exec()
        // đổi tên categoryId thành category trong data trả về
        .then((events) =>
          events.map((event) => {
            const eventObj = event.toObject();
            eventObj.category = eventObj.categoryId;
            delete eventObj.categoryId;
            return eventObj;
          })
        );
    } catch (error) {
      throw error;
    }
  }

  static async updateEvent(
    eventId,
    userId,
    updateData,
    newImages,
    imagesToDelete
  ) {
    try {
      const event = await Event.findOne({
        _id: eventId,
        // createdBy: userId,
        isDeleted: false,
      });
      const user = await UserService.getUser(userId);
      const role = user.role;

      if (role === "event_creator" && event.createdBy.toString() !== userId) {
        throw new Error("You don't have permission to update this event");
      }
      // if (!event) throw new Error("Event not found or unauthorized");

      if (imagesToDelete && imagesToDelete.length > 0) {
        if (typeof imagesToDelete === "string") {
          imagesToDelete = JSON.parse(imagesToDelete);
        }

        for (const image of imagesToDelete) {
          if (typeof image === "string") {
            const publicId = extractPublicId(image);
            console.log("Extracted Public ID:", publicId);

            await deleteFromCloudinary(publicId);

            const index = event.images.indexOf(image);
            if (index > -1) event.images.splice(index, 1);
          } else {
            console.error("Invalid image URL:", image);
          }
        }
      }

      // Thêm ảnh mới vào danh sách ảnh
      if (newImages && newImages.length > 0) {
        event.images.push(...newImages);
      }

      // Kiểm tra collaborators nếu được cập nhật
      if (updateData.collaborators) {
        const collaborators = await User.find({
          _id: { $in: updateData.collaborators },
          role: "event_creator",
        });

        if (collaborators.length !== updateData.collaborators.length) {
          throw new Error("Some collaborators are not event creators");
        }
      }

      Object.assign(event, updateData);
      await event.save();

      const users = await User.find({
        role: { $in: ["ticket_buyer", "admin"] },
      });

      const tokens = users
        .flatMap((user) => user.fcmTokens)
        .filter(Boolean);

      if (tokens.length) {
        const title = "The Event has been changed!";
        const body = `Check out the new update event: ${event.name}`;
        const data = {
          type: "event_update",
          eventId: event._id.toString(),
        };

        await notificationService.sendNotification(tokens, title, body, data);

        for (const user of users) {
          await notificationService.saveNotification(
            user._id,
            "event_update",
            title,
            body,
            data
          );
        }
      }

      return event;
    } catch (error) {
      throw error;
    }
  }

  static async deleteEvent(eventId, userId) {
    try {
      const event = await Event.findById(eventId);
      if (!event) {
        throw new Error("Event not found");
      }

      const user = await UserService.getUser(userId);
      const role = user.role;

      if (role === "event_creator" && event.createdBy.toString() !== userId) {
        throw new Error("You don't have permission to delete this event");
      }

      // Cập nhật status event thành cancelled theo đúng enum trong schema
      event.status = 'cancelled';

      // Cập nhật tất cả các vé của event thành cancelled
      const tickets = await Ticket.find({ eventId: eventId });
      const ticketIds = tickets.map(ticket => ticket._id);

      await Ticket.updateMany(
        { eventId: eventId },
        {
          $set: {
            status: "cancelled",
            cancelReason: "Event has been deleted by organizer"
          },
          $unset: {
            transferTo: "",
            transferRequestTime: ""
          }
        }
      );

      // Xóa tất cả transfer tickets liên quan từ collection transfer_tickets
      await TransferTicket.updateMany(
        { ticket: { $in: ticketIds } },
        {
          $set: {
            status: "cancelled",
            cancelReason: "Original event has been deleted"
          }
        }
      );

      // Xóa forum của event
      await Conversation.deleteMany({ eventId: eventId });

      // Soft delete event
      event.isDeleted = true;
      await event.save();

      const users = await User.find({
        role: { $in: ["ticket_buyer", "admin"] },
      });

      const tokens = users
        .flatMap((user) => user.fcmTokens)
        .filter(Boolean);

      if (tokens.length) {
        const title = "The Event has been cancelled!";
        const body = `Check out the new update event: ${event.name}`;
        const data = {
          type: "event_update",
          eventId: event._id.toString(),
        };

        await notificationService.sendNotification(tokens, title, body, data);

        for (const user of users) {
          await notificationService.saveNotification(
            user._id,
            "event_update",
            title,
            body,
            data
          );
        }
      }

      return event;
    } catch (error) {
      throw error;
    }
  }

  static async getEventDetails(eventId) {
    try {
      const event = await Event.findOne({ _id: eventId })
        .populate("collaborators", "_id name avatar studentId")
        .populate("createdBy", "_id name avatar studentId")
        .populate("conversation", "_id title")
        .populate({
          path: "createdBy",
          select: "_id name avatar studentId",
        })
        .populate("categoryId", "name");

      // đổi tên categoryId thành category trong data trả về
      if (event) {
        const eventObj = event.toObject();
        eventObj.category = eventObj.categoryId;
        delete eventObj.categoryId;
        return eventObj;
      }

      if (!event) throw new Error("Event not found");
      return event;
    } catch (error) {
      throw error;
    }
  }

  static async searchEvents(searchParams) {
    try {
      console.log("Search query:", searchParams);
      const query = { isDeleted: false };

      // Chuyển đổi ngày tìm kiếm sang UTC
      if (searchParams.date) {
        const GMT7_OFFSET = 7 * 60 * 60 * 1000;
        const searchDate = new Date(searchParams.date);
        const startOfDayUTC = new Date(searchDate.setHours(0, 0, 0, 0) - GMT7_OFFSET);
        const endOfDayUTC = new Date(searchDate.setHours(23, 59, 59, 999) - GMT7_OFFSET);
        
        query.date = {
          $gte: startOfDayUTC,
          $lt: endOfDayUTC
        };

        console.log("Search date range:", {
          searchDate: searchDate.toISOString(),
          startUTC: startOfDayUTC.toISOString(),
          endUTC: endOfDayUTC.toISOString(),
          startGMT7: new Date(startOfDayUTC.getTime() + GMT7_OFFSET).toISOString(),
          endGMT7: new Date(endOfDayUTC.getTime() + GMT7_OFFSET).toISOString()
        });
      }

      // Tìm kiếm theo tên sự kiện (không phân biệt hoa thường)
      if (searchParams.name) {
        query.name = { $regex: searchParams.name, $options: "i" };
      }
      // Tìm kiếm theo địa điểm (không phân biệt hoa thường)
      if (searchParams.location) {
        query.location = { $regex: searchParams.location, $options: "i" };
      }
      // Tìm kiếm theo category
      if (searchParams.categoryId) {
        query.categoryId = searchParams.categoryId;
      }
      // Tìm kiếm theo trạng thái
      if (searchParams.status) {
        query.status = searchParams.status;
      }

      return await Event.find(query)
        .sort({ createdAt: -1 })
        .populate("categoryId", "name")
        .populate("createdBy", "name")
        .populate("conversation", "_id title")
        .populate("collaborators", "_id name")
        .exec()
        // đổi tên categoryId thành category trong data trả về
        .then((events) =>
          events.map((event) => {
            const eventObj = event.toObject();
            eventObj.category = eventObj.categoryId;
            delete eventObj.categoryId;
            return eventObj;
          })
        );
    } catch (error) {
      throw error;
    }
  }

  static async getManagedEvents(userId) {
    try {
      const user = await UserService.getUser(userId);
      const role = user.role;
      let query = { isDeleted: false };
      if (role === "event_creator") {
        query = { isDeleted: false, $or: [{ createdBy: userId }, { collaborators: userId }] };
      } else if (role === "admin") {
        query = { isDeleted: false };
      }
      const events = await Event.find(query)
        .sort({ createdAt: -1 })
        .populate("createdBy", "_id name avatar studentId")
        .populate("conversation", "_id title")
        .populate("collaborators", "_id name")
        .populate({
          path: "categoryId",
          model: "Category",
          select: "_id name",
        })
        .exec();

      return events.map((event) => ({
        ...event.toObject(),
        category: event.categoryId.map((category) => ({
          _id: category._id,
          name: category.name,
        })),
        categoryId: undefined,
      }));
    } catch (error) {
      throw new Error("Error fetching managed events: " + error.message);
    }
  }

  static async getEventParticipants(eventId) {
    try {
      // Tìm tất cả vé đã book thành công cho sự kiện này
      const tickets = await Ticket.find({
        eventId: eventId,
        status: 'booked',
        paymentStatus: { $in: ['paid'] }  // Chỉ lấy vé đã thanh toán hoặc đã chuyển nhượng
      }).populate('buyerId', '_id name avatar studentId'); // Lấy thông tin người mua vé

      // Trích xuất thông tin người tham gia từ tickets
      const participants = tickets
        .map(ticket => ticket.buyerId)
        .filter(participant => participant !== null) // Lọc bỏ null
        .reduce((unique, participant) => {
          if (!unique.some(p => p._id.equals(participant._id))) {
            unique.push(participant);
          }
          return unique;
        }, []); // Loại bỏ trùng lặp

      return participants;
    } catch (error) {
      throw error;
    }
  }

}

module.exports = EventService;
