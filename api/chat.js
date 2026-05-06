import { createClient } from 'redis';

let client;

async function getRedisClient() {
  if (!client) {
    client = createClient({
      url: process.env.REDIS_URL || process.env.KV_URL
    });
    client.on('error', (err) => console.error('Redis Client Error', err));
    await client.connect();
  }
  return client;
}

export default async function handler(req, res) {
  try {
    const redis = await getRedisClient();
    const CHAT_KEY = 'quiznet_chat_messages';

    if (req.method === 'GET') {
      // Get last 50 messages
      const messages = await redis.lRange(CHAT_KEY, 0, 49);
      return res.status(200).json({ messages: messages.map(m => JSON.parse(m)).reverse() });
    }

    if (req.method === 'POST') {
      const { userId, text, userName } = req.body;
      if (!text || !userId) {
        return res.status(400).json({ error: 'Missing content' });
      }

      const message = {
        id: Math.random().toString(36).substr(2, 9),
        userId,
        userName: userName || 'Ẩn danh',
        text: text.substring(0, 500), // Limit message length
        timestamp: Date.now()
      };

      // Push to the front of the list
      await redis.lPush(CHAT_KEY, JSON.stringify(message));
      // Trim to keep only last 100 messages
      await redis.lTrim(CHAT_KEY, 0, 99);

      return res.status(201).json(message);
    }

    if (req.method === 'DELETE') {
      const { messageId, userId } = req.body;
      if (!messageId || !userId) {
        return res.status(400).json({ error: 'Missing parameters' });
      }

      // Get messages to find the exact one to remove
      const messages = await redis.lRange(CHAT_KEY, 0, -1);
      const targetMessageString = messages.find(m => {
        const parsed = JSON.parse(m);
        return parsed.id === messageId && parsed.userId === userId;
      });

      if (targetMessageString) {
        // Remove exactly one instance of this message string
        await redis.lRem(CHAT_KEY, 1, targetMessageString);
        return res.status(200).json({ success: true });
      }

      return res.status(404).json({ error: 'Message not found or unauthorized' });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (error) {
    console.error('Redis chat error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
