import logger from '../config/logger.config.js';
import configEnv from '../config/env.config.js';

class EmailService {
  // Send email verification email
  async sendVerificationEmail(email, verificationToken, displayName) {
    try {
      // For now, just log - you can implement with SendGrid, Nodemailer, etc.
      const verificationLink = `${configEnv.SECURITY.FRONTEND_URL}/verify-email?token=${verificationToken}`;

      logger.info(`Email Verification Link for ${email}:`);
      logger.info(verificationLink);

      // TODO: Implement actual email sending
      // await this.sendEmail({
      //   to: email,
      //   subject: 'Verify Your Email Address',
      //   template: 'email-verification',
      //   data: {
      //     displayName,
      //     verificationLink
      //   }
      // });

      console.log(`
          📧 EMAIL VERIFICATION
        To: ${email}
        Subject: Verify Your Email Address

        Hi ${displayName},

        Please click the link below to verify your email address:
        ${verificationLink}

        This link will expire in 24 hours.

        Thanks!
      `);

      return true;
    } catch (error) {
      logger.error('Failed to send verification email:', error);
      throw new Error('Could not send verification email');
    }
  }

  // Send password reset email
  async sendPasswordResetEmail(email, resetToken, displayName) {
    try {
      // For now, just log - you can implement with SendGrid, Nodemailer, etc.
      const resetLink = `${configEnv.SECURITY.FRONTEND_URL}/reset-password?token=${resetToken}`;

      logger.info(`Password Reset Link for ${email}:`);
      logger.info(resetLink);

      // TODO: Implement actual email sending
      // await this.sendEmail({
      //   to: email,
      //   subject: 'Reset Your Password',
      //   template: 'password-reset',
      //   data: {
      //     displayName,
      //     resetLink
      //   }
      // });

      console.log(`
        📧 PASSWORD RESET
        To: ${email}
        Subject: Reset Your Password

        Hi ${displayName},

        You requested a password reset. Click the link below to set a new password: ${resetLink}

        This link will expire in 10 minutes.

        If you didn't request this, please ignore this email.

        Thanks!
      `);

      return true;
    } catch (error) {
      logger.error('Failed to send password reset email:', error);
      throw new Error('Could not send password reset email');
    }
  }
}

export const emailService = new EmailService();
