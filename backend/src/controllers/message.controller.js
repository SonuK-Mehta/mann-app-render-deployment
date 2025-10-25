import { getReceiverSocketId, io, getOnlineContactsForUser } from '../services/socket.service.js';
import Message from '../models/message.model.js';
import User from '../models/user.model.js';
import Follow from '../models/follow.model.js';
import ApiResponse from '../utils/api-response.js';
import ApiError from '../utils/api-error.js';
import asyncHandler from '../utils/async-handler.js';
import { uploadBase64ToCloudinary } from '../config/media-upload.config.js'; // ✅ Import from your config

// ✅ Get users you can message (following/followers + search)
export const getMessageableUsers = asyncHandler(async (req, res) => {
  const loggedInUserId = req.user._id;
  const { search = '', page = 1, limit = 20 } = req.query;

  try {
    // Get users that current user follows or is followed by
    const [following, followers] = await Promise.all([
      Follow.find({ follower: loggedInUserId }).populate(
        'following',
        'username displayName avatar isVerified'
      ),
      Follow.find({ following: loggedInUserId }).populate(
        'follower',
        'username displayName avatar isVerified'
      ),
    ]);

    // Combine and deduplicate contacts
    const contactUsers = new Map();

    following.forEach((f) => {
      const user = f.following;
      contactUsers.set(user._id.toString(), {
        ...user.toObject(),
        relationshipType: 'following',
      });
    });

    followers.forEach((f) => {
      const user = f.follower;
      const existing = contactUsers.get(user._id.toString());
      contactUsers.set(user._id.toString(), {
        ...user.toObject(),
        relationshipType: existing ? 'mutual' : 'follower',
      });
    });

    let messageableUsers = Array.from(contactUsers.values());

    // Apply search filter if provided
    if (search) {
      messageableUsers = messageableUsers.filter(
        (user) =>
          user.username.toLowerCase().includes(search.toLowerCase()) ||
          user.displayName.toLowerCase().includes(search.toLowerCase())
      );
    }

    // Add online status
    messageableUsers = messageableUsers.map((user) => ({
      ...user,
      isOnline: !!getReceiverSocketId(user._id.toString()),
    }));

    // Sort by online status first, then by display name
    messageableUsers.sort((a, b) => {
      if (a.isOnline && !b.isOnline) return -1;
      if (!a.isOnline && b.isOnline) return 1;
      return a.displayName.localeCompare(b.displayName);
    });

    // Apply pagination
    const startIndex = (page - 1) * limit;
    const paginatedUsers = messageableUsers.slice(startIndex, startIndex + limit);

    return ApiResponse.success(
      res,
      {
        users: paginatedUsers,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: messageableUsers.length,
          totalPages: Math.ceil(messageableUsers.length / limit),
        },
      },
      'Messageable users retrieved successfully'
    );
  } catch (error) {
    console.log('Error in getMessageableUsers:', error);
    throw ApiError.internal('Failed to get messageable users');
  }
});

// ✅ Get messages between users (with read status update)
export const getMessagesByUserId = asyncHandler(async (req, res) => {
  const myId = req.user._id;
  const { id: userToChatId } = req.params;
  const { page = 1, limit = 50 } = req.query;

  try {
    // Verify the other user exists and you can message them
    const otherUser = await User.findById(userToChatId).select('-password');
    if (!otherUser) {
      throw ApiError.notFound('User not found');
    }

    // Check if users are connected (following each other or one follows the other)
    const connection = await Follow.findOne({
      $or: [
        { follower: myId, following: userToChatId },
        { follower: userToChatId, following: myId },
      ],
    });

    if (!connection) {
      throw ApiError.forbidden('You can only message users you follow or who follow you');
    }

    // Get messages with pagination
    const skip = (page - 1) * limit;
    const [messages, totalCount] = await Promise.all([
      Message.find({
        $or: [
          { senderId: myId, receiverId: userToChatId },
          { senderId: userToChatId, receiverId: myId },
        ],
      })
        .populate('senderId', 'username displayName avatar isVerified')
        .populate('receiverId', 'username displayName avatar isVerified')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit),

      Message.countDocuments({
        $or: [
          { senderId: myId, receiverId: userToChatId },
          { senderId: userToChatId, receiverId: myId },
        ],
      }),
    ]);

    // ✅ Mark messages from other user as read
    const unreadMessages = await Message.find({
      senderId: userToChatId,
      receiverId: myId,
      status: { $ne: 'read' },
    });

    if (unreadMessages.length > 0) {
      await Message.updateMany(
        { senderId: userToChatId, receiverId: myId, status: { $ne: 'read' } },
        { status: 'read', readAt: new Date() }
      );

      // Notify sender via socket
      const senderSocketId = getReceiverSocketId(userToChatId);
      if (senderSocketId) {
        io.to(senderSocketId).emit('messagesRead', {
          messageIds: unreadMessages.map((msg) => msg._id),
          readBy: myId,
          readAt: new Date(),
        });
      }
    }

    return ApiResponse.success(
      res,
      {
        messages: messages.reverse(), // Reverse to show oldest first
        otherUser,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
          hasMore: totalCount > skip + messages.length,
        },
      },
      'Messages retrieved successfully'
    );
  } catch (error) {
    console.log('Error in getMessages controller: ', error.message);
    throw error;
  }
});

// ✅ Enhanced send message with both JSON and form-data support
export const sendMessage = asyncHandler(async (req, res) => {
  const { id: receiverId } = req.params;
  const senderId = req.user._id;

  try {
    let text, imageUrl, videoUrl;
    let mediaType = 'text';
    const contentType = req.get('content-type') || '';

    // ✅ Handle different content types
    if (contentType.includes('multipart/form-data')) {
      // Handle form-data request - files are already uploaded to Cloudinary by your config
      text = req.body.text;

      // Get URLs from uploaded files
      if (req.files?.image?.[0]) {
        imageUrl = req.files.image[0].path; // Cloudinary URL from your chatMediaStorage
        mediaType = text ? 'mixed' : 'image';
      }

      if (req.files?.video?.[0]) {
        videoUrl = req.files.video[0].path; // Cloudinary URL from your chatMediaStorage
        mediaType = text || imageUrl ? 'mixed' : 'video';
      }
    } else {
      // Handle JSON request with base64 data
      const { text: jsonText, image: jsonImage, video: jsonVideo } = req.body;
      text = jsonText;

      // Upload base64 data to Cloudinary using your config function
      if (jsonImage) {
        const uploadResponse = await uploadBase64ToCloudinary(jsonImage, 'image');
        imageUrl = uploadResponse.secure_url;
        mediaType = text ? 'mixed' : 'image';
      }

      if (jsonVideo) {
        const uploadResponse = await uploadBase64ToCloudinary(jsonVideo, 'video');
        videoUrl = uploadResponse.secure_url;
        mediaType = text || imageUrl ? 'mixed' : 'video';
      }
    }

    // Validations
    if (!text && !imageUrl && !videoUrl) {
      throw ApiError.badRequest('Text, image, or video is required.');
    }

    if (senderId.equals(receiverId)) {
      throw ApiError.badRequest('Cannot send messages to yourself.');
    }

    // Check if receiver exists and you can message them
    const receiver = await User.findById(receiverId);
    if (!receiver) {
      throw ApiError.notFound('Receiver not found.');
    }

    // Check connection (following relationship)
    const connection = await Follow.findOne({
      $or: [
        { follower: senderId, following: receiverId },
        { follower: receiverId, following: senderId },
      ],
    });

    if (!connection) {
      throw ApiError.forbidden('You can only message users you follow or who follow you');
    }

    // Create message
    const newMessage = new Message({
      senderId,
      receiverId,
      text,
      image: imageUrl,
      video: videoUrl,
      mediaType,
      status: 'sent',
    });

    await newMessage.save();

    // Populate sender info
    await newMessage.populate('senderId', 'username displayName avatar isVerified');

    // ✅ Send real-time message
    const receiverSocketId = getReceiverSocketId(receiverId);
    if (receiverSocketId) {
      // Update status to delivered
      newMessage.status = 'delivered';
      await newMessage.save();

      io.to(receiverSocketId).emit('newMessage', {
        ...newMessage.toObject(),
        status: 'delivered',
      });
    }

    return ApiResponse.success(res, newMessage, 'Message sent successfully');
  } catch (error) {
    console.log('Error in sendMessage controller: ', error.message);
    throw error;
  }
});

// ✅ Get chat partners (recent conversations)
export const getChatPartners = asyncHandler(async (req, res) => {
  const loggedInUserId = req.user._id;
  const { page = 1, limit = 20 } = req.query;

  try {
    // Get recent conversations using aggregation
    const conversations = await Message.aggregate([
      {
        $match: {
          $or: [{ senderId: loggedInUserId }, { receiverId: loggedInUserId }],
        },
      },
      {
        $sort: { createdAt: -1 },
      },
      {
        $group: {
          _id: {
            $cond: [{ $eq: ['$senderId', loggedInUserId] }, '$receiverId', '$senderId'],
          },
          lastMessage: { $first: '$$ROOT' },
          unreadCount: {
            $sum: {
              $cond: [
                {
                  $and: [{ $eq: ['$receiverId', loggedInUserId] }, { $ne: ['$status', 'read'] }],
                },
                1,
                0,
              ],
            },
          },
        },
      },
      {
        $sort: { 'lastMessage.createdAt': -1 },
      },
      {
        $skip: (page - 1) * limit,
      },
      {
        $limit: parseInt(limit),
      },
    ]);

    // Populate user information
    await Message.populate(conversations, {
      path: '_id',
      select: 'username displayName avatar isVerified',
      model: 'User',
    });

    // Add online status
    const chatPartners = conversations
      .filter((conv) => conv._id) // Filter out null users
      .map((conv) => ({
        user: conv._id,
        lastMessage: conv.lastMessage,
        unreadCount: conv.unreadCount,
        isOnline: !!getReceiverSocketId(conv._id._id.toString()),
      }));

    return ApiResponse.success(
      res,
      {
        conversations: chatPartners,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          hasMore: chatPartners.length === limit,
        },
      },
      'Chat partners retrieved successfully'
    );
  } catch (error) {
    console.error('Error in getChatPartners: ', error.message);
    throw ApiError.internal('Failed to get chat partners');
  }
});

// ✅ Get online contacts
export const getOnlineContacts = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  try {
    const onlineContacts = await getOnlineContactsForUser(userId);
    return ApiResponse.success(
      res,
      { contacts: onlineContacts },
      'Online contacts retrieved successfully'
    );
  } catch (error) {
    console.error('Error in getOnlineContacts: ', error.message);
    throw ApiError.internal('Failed to get online contacts');
  }
});

// ✅ Search users to start new conversation
export const searchUsersToMessage = asyncHandler(async (req, res) => {
  const { q: search, page = 1, limit = 10 } = req.query;
  const currentUserId = req.user._id;

  try {
    if (!search || search.trim().length < 2) {
      throw ApiError.badRequest('Search query must be at least 2 characters');
    }

    // Get users you follow or who follow you
    const [following, followers] = await Promise.all([
      Follow.find({ follower: currentUserId }).select('following'),
      Follow.find({ following: currentUserId }).select('follower'),
    ]);

    const messageableUserIds = [
      ...following.map((f) => f.following),
      ...followers.map((f) => f.follower),
    ];

    // Search within messageable users
    const users = await User.find({
      _id: { $in: messageableUserIds, $ne: currentUserId },
      $or: [
        { username: { $regex: search, $options: 'i' } },
        { displayName: { $regex: search, $options: 'i' } },
      ],
    })
      .select('username displayName avatar isVerified')
      .limit(parseInt(limit))
      .skip((parseInt(page) - 1) * parseInt(limit));

    // Add online status
    const usersWithStatus = users.map((user) => ({
      ...user.toObject(),
      isOnline: !!getReceiverSocketId(user._id.toString()),
    }));

    return ApiResponse.success(
      res,
      {
        users: usersWithStatus,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          hasMore: users.length === limit,
        },
      },
      'Users found successfully'
    );
  } catch (error) {
    console.error('Error in searchUsersToMessage: ', error.message);
    throw error;
  }
});
