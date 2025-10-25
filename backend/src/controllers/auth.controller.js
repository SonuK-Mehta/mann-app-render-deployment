import { emailService } from '../services/email.service.js';
import { authService } from '../services/auth.service.js';
import { User } from '../models/index.js';
import ApiError from '../utils/api-error.js';
import ApiResponse from '../utils/api-response.js';
import asyncHandler from '../utils/async-handler.js';
import logger from '../config/logger.config.js';
import configEnv from '../config/env.config.js';

class AuthController {
  // Register new user
  register = asyncHandler(async (req, res) => {
    const { username, email, password, displayName } = req.body;

    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ email: email.toLowerCase() }, { username: username.toLowerCase() }],
    });

    if (existingUser) {
      if (existingUser.email === email.toLowerCase()) {
        throw ApiError.conflict('Email is already registered');
      }
      if (existingUser.username === username.toLowerCase()) {
        throw ApiError.conflict('Username is already taken');
      }
    }

    // Create new user
    const user = new User({
      username: username.toLowerCase(),
      email: email.toLowerCase(),
      password,
      displayName,
      bio: `Hi, I'm ${displayName.split(' ')[0]}!`,
      avatar: configEnv.DEFAULT_PROFILE_URL,
      coverPhoto: configEnv.DEFAULT_COVER_URL,
    });

    await user.save();

    console.log(user.avatar);
    console.log(user.coverPhoto);

    // Generate email verification token
    const verificationToken = await authService.createEmailVerificationToken(user._id);

    // Send verification email
    await emailService.sendVerificationEmail(user.email, verificationToken, user.displayName);
    logger.info(`New user registered: ${user.email}`);

    return ApiResponse.created(res, {
      message: 'Account created successfully. Please check your email to verify your account.',
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        isVerified: user.isVerified,
        // Remove the emial verification in Prod.
        emailVerificationToken: verificationToken,
      },
    });
  });

  // Verify email with token
  verifyEmail = asyncHandler(async (req, res) => {
    const { token } = req.body;

    if (!token) {
      throw ApiError.badRequest('Verification token is required');
    }

    // Verify the email verification token
    const userId = await authService.verifyEmailVerificationToken(token);

    // Find the user
    const user = await User.findById(userId);

    if (!user) {
      throw ApiError.notFound('User not found');
    }

    if (user.isVerified) {
      return ApiResponse.success(res, {
        message: 'Email is already verified. You can now login.',
        user: {
          id: user._id,
          username: user.username,
          email: user.email,
          displayName: user.displayName,
          isVerified: user.isVerified,
        },
      });
    }

    // Update user as verified
    user.isVerified = true;
    await user.save({ validateBeforeSave: false });

    logger.info(`Email verified for user: ${user.email}`);

    return ApiResponse.success(res, {
      message: 'Email verified successfully. You can now login.',
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        isVerified: user.isVerified,
      },
    });
  });

  // Login user
  login = asyncHandler(async (req, res) => {
    const { identifier, password } = req.body;

    // Find user by email or username (case insensitive)
    const user = await User.findOne({
      $or: [{ email: identifier.toLowerCase() }, { username: identifier.toLowerCase() }],
    }).select('+password');

    if (!user) {
      throw ApiError.unauthorized('Invalid credentials');
    }

    // Check password
    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      throw ApiError.unauthorized('Invalid credentials');
    }

    // Check if account is active
    if (!user.isActive) {
      throw ApiError.unauthorized('Account has been deactivated');
    }

    // Check if email is verified
    if (!user.isVerified) {
      throw ApiError.unauthorized('Please verify your email before logging in');
    }

    // Generate tokens
    const { accessToken, refreshToken, tokenId } = await authService.createTokens(user._id);

    // Store refresh token in database
    await authService.storeRefreshToken(refreshToken, user._id, req, tokenId);

    // Update last active time
    user.lastActiveAt = new Date();
    await user.save({ validateBeforeSave: false });

    // 👉 set refresh token in cookie (readable in JS for dev)
    res.cookie('refreshToken', refreshToken, {
      httpOnly: false, // ✅ JS can read it in dev
      secure: false, // ✅ allow HTTP for localhost
      sameSite: 'lax',
      path: '/', // ✅ make cookie available everywhere
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    // In Production
    // res.cookie('refreshToken', refreshToken, {
    //   httpOnly: process.env.NODE_ENV === 'production', // ⬅️ false in dev
    //   secure: process.env.NODE_ENV === 'production', // only HTTPS in prod
    //   sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
    //   maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    // });

    logger.info(`User logged in: ${user.email}`);

    return ApiResponse.success(res, {
      message: 'Login successful',
      accessToken,
      refreshToken,
      user: {
        id: user._id,
        username: user.username,
        email: user.email,
        displayName: user.displayName,
        avatar: user.avatar,
        isVerified: user.isVerified,
        role: user.role,
      },
    });
  });

  // Refresh access token - Implement properly
  refresh = asyncHandler(async (req, res) => {
    // Get refresh token from body or cookie
    const refreshToken = req.body.refreshToken || req.cookies.refreshToken;

    if (!refreshToken) {
      throw ApiError.unauthorized('Refresh token is required');
    }

    // Get new tokens (with rotation by default)
    const {
      accessToken,
      refreshToken: newRefreshToken,
      tokenId,
    } = await authService.getNewAccessToken(refreshToken, true);

    // 👉 Update cookie with the new refresh token
    res.cookie('refreshToken', newRefreshToken, {
      httpOnly: false, // ✅ dev mode: JS can access
      secure: false, // ✅ allow http://localhost
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });

    logger.info('Access token refreshed');

    return ApiResponse.success(res, {
      message: 'Token refreshed successfully',
      accessToken,
      newRefreshToken,
      tokenId,
    });
  });

  // Forgot password
  forgotPassword = asyncHandler(async (req, res) => {
    const { email } = req.body;

    // Find user
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      // Don't reveal if email exists - security best practice
      return ApiResponse.success(res, {
        message: 'If this email is registered, you will receive a password reset link.',
      });
    }

    if (!user.isActive) {
      throw ApiError.unauthorized('Account has been deactivated');
    }

    // Generate password reset token
    const resetToken = await authService.createPasswordResetToken(user._id);

    // Send password reset email
    await emailService.sendPasswordResetEmail(user.email, resetToken, user.displayName);

    logger.info(`Password reset requested for: ${user.email}`);

    return ApiResponse.success(res, {
      message: 'If this email is registered, you will receive a password reset link.',
      resetLink: 'Reset Password on Routes -> /reset-password',
      passwordResetToken: resetToken,
    });
  });

  // Reset password with token
  resetPassword = asyncHandler(async (req, res) => {
    const { token, password } = req.body;

    // Verify reset token
    const userId = await authService.verifyPasswordResetToken(token);

    // Update user password
    const user = await User.findById(userId);
    if (!user) {
      throw ApiError.notFound('User not found');
    }

    user.password = password;
    await user.save();

    // Revoke all refresh tokens (force re-login on all devices)
    await authService.removeAllUserTokens(userId);

    logger.info(`Password reset completed for: ${user.email}`);

    return ApiResponse.success(res, {
      message: 'Password reset successful. Please login with your new password.',
    });
  });

  // Resend verification email
  resendEmailVerification = asyncHandler(async (req, res) => {
    const { email } = req.body;

    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      throw ApiError.notFound('User not found');
    }

    if (user.isVerified) {
      throw ApiError.badRequest('Email is already verified');
    }

    if (!user.isActive) {
      throw ApiError.unauthorized('Account has been deactivated');
    }

    // Generate new verification token
    const verificationToken = await authService.createEmailVerificationToken(user._id);

    // Send verification email
    try {
      await emailService.sendVerificationEmail(user.email, verificationToken, user.displayName);
      logger.info(`Verification email resent to: ${user.email}`);
    } catch (emailError) {
      logger.error('Failed to resend verification email:', emailError);
      throw ApiError.internal('Failed to send verification email');
    }

    return ApiResponse.success(res, {
      message: 'Verification email sent successfully',
      emailVerificationToken: verificationToken,
    });
  });

  // Check if email exists (utility)
  checkEmail = asyncHandler(async (req, res) => {
    const { email } = req.query;

    const user = await User.findOne({ email: email.toLowerCase() });

    return ApiResponse.success(res, {
      exists: !!user,
    });
  });
}

export const authController = new AuthController();
