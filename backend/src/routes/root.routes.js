// Root route - Welcome message
import express from 'express';
const router = express.Router();

router.get('/', (req, res) => {
  res.status(200).json({
    success: true,
    message: '🇮🇳 Welcome to Maan App — Made in India Social Media Platform 🚀',
    description:
      'Maan App is a next-gen social platform where thoughts connect, voices matter, and ideas spark change.',
    environment: process.env.NODE_ENV || 'development',
    api_version: 'v1',
    author: 'Sonu Mehta',
  });
});

export default router;
