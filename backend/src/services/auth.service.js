import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import configEnv from '../config/env.config.js';
import ApiError from '../utils/api-error.js';
import logger from '../config/logger.config.js';

import { User, AuthToken } from '../models/index.js';

class AuthService {
  // Generate both access and refresh tokens
  async createTokens(userId) {
    try {
      // Create access token (short-lived)
      const accessToken = jwt.sign({ userId, type: 'access' }, configEnv.JWT.ACCESS_SECRET, {
        expiresIn: configEnv.JWT.ACCESS_EXPIRE,
      });

      // Create refresh token (long-lived)
      const tokenId = crypto.randomUUID();
      const refreshToken = jwt.sign(
        { userId, type: 'refresh', tokenId },
        configEnv.JWT.REFRESH_SECRET,
        { expiresIn: configEnv.JWT.REFRESH_EXPIRE }
      );

      return { accessToken, refreshToken, tokenId };
    } catch (error) {
      logger.error('Failed to create tokens:', error);
      throw ApiError.internal('Could not create authentication tokens');
    }
  }

  // Check if a token is valid
  validateToken(token, secret) {
    try {
      return jwt.verify(token, secret);
    } catch (error) {
      // Handle different JWT errors
      if (error.name === 'TokenExpiredError') {
        throw ApiError.unauthorized('Your session has expired');
      }
      if (error.name === 'JsonWebTokenError') {
        throw ApiError.unauthorized('Invalid authentication token');
      }
      throw ApiError.unauthorized('Authentication failed');
    }
  }

  // Save refresh token to database when user logs in
  async storeRefreshToken(refreshToken, userId, request, tokenId) {
    try {
      // First, verify the token is valid
      const decoded = this.validateToken(refreshToken, configEnv.JWT.REFRESH_SECRET);

      // Create new token record
      const tokenRecord = new AuthToken({
        userId,
        token: refreshToken,
        tokenId: tokenId || decoded.tokenId,
        type: 'refresh',
        expiresAt: new Date(decoded.exp * 1000), // Convert JWT timestamp to Date
        deviceInfo: {
          userAgent: request.get('User-Agent'),
          ip: request.ip || request.connection.remoteAddress,
          deviceName: this.getDeviceType(request.get('User-Agent')),
        },
      });

      await tokenRecord.save();
      logger.info(`New session created for user: ${userId}`);

      return tokenRecord;
    } catch (error) {
      logger.error('Failed to store refresh token:', error);
      throw ApiError.internal('Could not save session');
    }
  }

  // Get new access token using refresh token
  async getNewAccessToken(refreshToken, rotateRefreshToken = true) {
    try {
      // 1. Check if refresh token is valid
      const decoded = this.validateToken(refreshToken, configEnv.JWT.REFRESH_SECRET);

      // 2. Find token in database
      const tokenRecord = await AuthToken.findActiveToken(refreshToken, 'refresh');

      if (!tokenRecord) {
        throw ApiError.unauthorized('Session expired or invalid');
      }

      // 3. Make sure user still exists and is active
      const user = await User.findById(decoded.userId);
      if (!user || !user.isActive) {
        await this.removeRefreshToken(refreshToken, decoded.userId);
        throw ApiError.unauthorized('User account not found or deactivated');
      }

      // 4. Rotate vs Reuse strategy
      if (rotateRefreshToken) {
        // STRATEGY A: Refresh Token Rotation (More Secure)
        const {
          accessToken,
          refreshToken: newRefreshToken,
          tokenId,
        } = await this.createTokens(decoded.userId);

        // Decode new refresh token to extract its expiry
        const decodedNew = this.validateToken(newRefreshToken, configEnv.JWT.REFRESH_SECRET);

        // Update existing token record
        tokenRecord.token = newRefreshToken;
        tokenRecord.tokenId = tokenId;
        tokenRecord.expiresAt = new Date(decodedNew.exp * 1000);
        tokenRecord.lastUsedAt = new Date();

        await tokenRecord.save();

        logger.info(`Refresh token rotated for user=${decoded.userId}, tokenId=${tokenId}`);

        return { accessToken, refreshToken: newRefreshToken, tokenId };
      } else {
        // STRATEGY B: Reuse Refresh Token (Simpler)
        // Generate only new access token - FIXED: Only generate access token
        const accessToken = jwt.sign(
          { userId: decoded.userId, type: 'access' },
          configEnv.JWT.ACCESS_SECRET,
          {
            expiresIn: configEnv.JWT.ACCESS_EXPIRE,
          }
        );

        // Update last used time
        tokenRecord.lastUsedAt = new Date();
        await tokenRecord.save();

        logger.info(`Access token refreshed for user: ${decoded.userId}`);
        return { accessToken, refreshToken }; // Return the original refresh token
      }
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      logger.error('Token refresh failed:', error);
      throw ApiError.unauthorized('Could not refresh session');
    }
  }

  // Remove a specific refresh token (single device logout)
  async removeRefreshToken(refreshToken, userId) {
    try {
      const tokenRecord = await AuthToken.findActiveToken(refreshToken, 'refresh');

      if (!tokenRecord || tokenRecord.userId.toString() !== userId) {
        logger.warn(`No active session found for user: ${userId}`);
        return false;
      }

      // Use instance method to revoke
      await tokenRecord.revoke();

      logger.info(`Session ended for user: ${userId}, tokenId=${tokenRecord.tokenId}`);
      return true;
    } catch (error) {
      logger.error('Failed to remove refresh token:', error);
      throw ApiError.internal('Could not end session');
    }
  }

  // Remove all refresh tokens for user (logout from all devices)
  async removeAllUserTokens(userId) {
    try {
      const result = await AuthToken.revokeUserTokens(userId, 'refresh');

      logger.info(`All sessions ended for user: ${userId} (${result.modifiedCount} devices)`);
      return result.modifiedCount;
    } catch (error) {
      logger.error('Failed to remove all user tokens:', error);
      throw ApiError.internal('Could not end all sessions');
    }
  }

  // Create email verification token
  async createEmailVerificationToken(userId) {
    try {
      // Generate random token
      const verificationToken = crypto.randomBytes(32).toString('hex');

      // Hash it for database storage
      const hashedToken = crypto.createHash('sha256').update(verificationToken).digest('hex');

      // Save to database
      const tokenRecord = new AuthToken({
        userId,
        token: hashedToken,
        type: 'email_verification',
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      });

      await tokenRecord.save();

      // Return the unhashed token (to send via email)
      return verificationToken;
    } catch (error) {
      logger.error('Failed to create email verification token:', error);
      throw ApiError.internal('Could not create email verification token');
    }
  }

  // Verify email verification token
  async verifyEmailVerificationToken(verificationToken) {
    try {
      // Hash the provided token
      const hashedToken = crypto.createHash('sha256').update(verificationToken).digest('hex');

      // Find matching token in database
      const tokenRecord = await AuthToken.findOne({
        token: hashedToken,
        type: 'email_verification',
        isActive: true,
        expiresAt: { $gt: new Date() },
      });

      if (!tokenRecord) {
        throw ApiError.badRequest('Invalid or expired verification token');
      }

      // Mark token as used
      tokenRecord.isActive = false;
      tokenRecord.revokedAt = new Date();
      await tokenRecord.save();

      return tokenRecord.userId;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      logger.error('Email verification token verification failed:', error);
      throw ApiError.internal('Could not verify email verification token');
    }
  }

  // Create password reset token
  async createPasswordResetToken(userId) {
    try {
      // Generate random token
      const resetToken = crypto.randomBytes(32).toString('hex');

      // Hash it for database storage
      const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

      // Invalidate any existing password reset tokens for this user
      await AuthToken.updateMany(
        { userId, type: 'password_reset', isActive: true },
        { $set: { isActive: false, revokedAt: new Date() } }
      );

      // Save to database
      const tokenRecord = new AuthToken({
        userId,
        token: hashedToken,
        type: 'password_reset',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000), // 10 minutes
      });

      await tokenRecord.save();

      // Return the unhashed token (to send via email)
      return resetToken;
    } catch (error) {
      logger.error('Failed to create password reset token:', error);
      throw ApiError.internal('Could not create password reset token');
    }
  }

  // Verify password reset token
  async verifyPasswordResetToken(resetToken) {
    try {
      // Hash the provided token
      const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');

      // Find matching token in database
      const tokenRecord = await AuthToken.findOne({
        token: hashedToken,
        type: 'password_reset',
        isActive: true,
        expiresAt: { $gt: new Date() },
      });

      if (!tokenRecord) {
        throw ApiError.badRequest('Invalid or expired reset token');
      }

      // Mark token as used
      tokenRecord.isActive = false;
      tokenRecord.revokedAt = new Date();
      await tokenRecord.save();

      return tokenRecord.userId;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }
      logger.error('Password reset token verification failed:', error);
      throw ApiError.internal('Could not verify password reset token');
    }
  }

  // Get list of user's active sessions/devices
  async getUserActiveSessions(userId) {
    try {
      const sessions = await AuthToken.find({
        userId,
        type: 'refresh',
        isActive: true,
        expiresAt: { $gt: new Date() }, // Only non-expired tokens
      })
        .select('deviceInfo createdAt lastUsedAt tokenId')
        .sort({ lastUsedAt: -1 }); // Most recent first

      return sessions.map((session) => ({
        id: session.tokenId,
        userAgent: session.deviceInfo?.userAgent || 'Unknown Device',
        device: session.deviceInfo?.deviceName || 'Unknown Device',
        ip: session.deviceInfo?.ip,
        loginTime: session.createdAt,
        lastUsed: session.lastUsedAt,
      }));
    } catch (error) {
      logger.error('Failed to get user sessions:', error);
      throw ApiError.internal('Could not retrieve active sessions');
    }
  }

  // Remove specific sessions/devices
  async removeSpecificSession(userId, tokenId) {
    try {
      const result = await AuthToken.updateOne(
        {
          tokenId,
          userId,
          type: 'refresh',
          isActive: true,
        },
        {
          $set: {
            isActive: false,
            revokedAt: new Date(),
          },
        }
      );

      if (result.modifiedCount === 0) {
        throw ApiError.notFound('Session not found');
      }

      return result;
    } catch (error) {
      logger.error('Failed to remove specific session:', error);
      throw error;
    }
  }

  // Helper: Detect device type from user agent
  getDeviceType(userAgent) {
    if (!userAgent) return 'Unknown Device';

    const ua = userAgent.toLowerCase();

    if (ua.includes('mobile') || ua.includes('android') || ua.includes('iphone')) {
      return 'Mobile Device';
    }
    if (ua.includes('tablet') || ua.includes('ipad')) {
      return 'Tablet';
    }
    return 'Desktop Computer';
  }

  // Helper: Clean up expired tokens (run this periodically)
  // async cleanupExpiredTokens() {
  //   try {
  //     const result = await AuthToken.deleteMany({
  //       expiresAt: { $lt: new Date() },
  //       isActive: false,
  //     });

  //     logger.info(`Cleaned up ${result.deletedCount} expired tokens`);
  //     return result.deletedCount;
  //   } catch (error) {
  //     logger.error('Failed to cleanup expired tokens:', error);
  //     throw ApiError.internal('Could not cleanup expired tokens');
  //   }
  // }

  // Clean up old/expired tokens (run periodically)
  // async cleanupOldTokens() {
  //   try {
  //     const result = await AuthToken.deleteMany({
  //       $or: [
  //         { expiresAt: { $lt: new Date() } },
  //         {
  //           isActive: false,
  //           revokedAt: { $lt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
  //         },
  //       ],
  //     });

  //     logger.info(`Cleaned up ${result.deletedCount} old tokens`);
  //     return result.deletedCount;
  //   } catch (error) {
  //     logger.error('Token cleanup failed:', error);
  //     return 0;
  //   }
  // }
}

export const authService = new AuthService();
