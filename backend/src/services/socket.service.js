import { Server } from 'socket.io';
import http from 'http';
import app from '../app.js'; // ✅ use your main app here
import configEnv from '../config/env.config.js';
import { socketAuthMiddleware } from '../middleware/socket.auth.middleware.js';
import Follow from '../models/follow.model.js';
import User from '../models/user.model.js';

const server = http.createServer(app); // ✅ attach socket.io to this app

const io = new Server(server, {
  cors: {
    origin: [configEnv.FRONTEND_URL || 'http://localhost:3000'],
    credentials: true,
  },
});

// middleware + socket logic as before
io.use(socketAuthMiddleware);

const userSocketMap = {};
export function getReceiverSocketId(userId) {
  return userSocketMap[userId];
}

// ✅ Get online users that current user can message (following/followers)
export async function getOnlineContactsForUser(userId) {
  try {
    // Get users that current user follows or is followed by
    const [following, followers] = await Promise.all([
      Follow.find({ follower: userId }).populate(
        'following',
        'username displayName avatar isVerified'
      ),
      Follow.find({ following: userId }).populate(
        'follower',
        'username displayName avatar isVerified'
      ),
    ]);

    const contactIds = new Set([
      ...following.map((f) => f.following._id.toString()),
      ...followers.map((f) => f.follower._id.toString()),
    ]);

    // Filter online contacts
    const onlineContacts = Array.from(contactIds)
      .filter((contactId) => userSocketMap[contactId])
      .map((contactId) => {
        const contact = [
          ...following.map((f) => f.following),
          ...followers.map((f) => f.follower),
        ].find((user) => user._id.toString() === contactId);

        return {
          _id: contactId,
          username: contact.username,
          displayName: contact.displayName,
          avatar: contact.avatar,
          isVerified: contact.isVerified,
          isOnline: true,
        };
      });

    return onlineContacts;
  } catch (error) {
    console.error('Error getting online contacts:', error);
    return [];
  }
}

io.on('connection', (socket) => {
  console.log('✅ User connected:', socket.user.displayName || socket.user.username);

  const userId = socket.userId;
  userSocketMap[userId] = socket.id;

  // ✅ Send online contacts to newly connected user
  getOnlineContactsForUser(userId).then((onlineContacts) => {
    socket.emit('onlineContacts', onlineContacts);
  });

  // ✅ Notify contacts that this user is now online
  socket.broadcast.emit('userOnline', {
    userId: userId,
    user: {
      _id: socket.user._id,
      username: socket.user.username,
      displayName: socket.user.displayName,
      avatar: socket.user.avatar,
      isVerified: socket.user.isVerified,
    },
  });

  // ✅ Handle typing indicators
  socket.on('typing', (data) => {
    const { receiverId } = data;
    const receiverSocketId = getReceiverSocketId(receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('userTyping', {
        userId: userId,
        user: socket.user,
      });
    }
  });

  socket.on('stopTyping', (data) => {
    const { receiverId } = data;
    const receiverSocketId = getReceiverSocketId(receiverId);
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('userStoppedTyping', {
        userId: userId,
      });
    }
  });

  // ✅ Handle message read receipts
  socket.on('markAsRead', async (data) => {
    const { messageIds, senderId } = data;
    const senderSocketId = getReceiverSocketId(senderId);
    if (senderSocketId) {
      io.to(senderSocketId).emit('messagesRead', {
        messageIds,
        readBy: userId,
        readAt: new Date(),
      });
    }
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('❌ User disconnected:', socket.user.displayName || socket.user.username);
    delete userSocketMap[userId];

    // Notify all users that this user went offline
    socket.broadcast.emit('userOffline', {
      userId: userId,
    });
  });
});

export { io, app, server };
