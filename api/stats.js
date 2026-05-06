import { createClient } from 'redis';

// Singleton connection to avoid multiple connections in serverless environment
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
  const now = Date.now();
  const activeThreshold = now - 30000; // 30 seconds ago

  try {
    const redis = await getRedisClient();

    if (req.method === 'POST') {
      const { userId } = req.body;
      if (userId) {
        // Add or update user's last seen timestamp
        await redis.zAdd('active_learners', { score: now, value: userId });
      }
    }

    // Remove users who haven't been seen for more than 30 seconds
    await redis.zRemRangeByScore('active_learners', 0, activeThreshold);
    
    // Count remaining active users
    const count = await redis.zCard('active_learners');

    return res.status(200).json({ activeCount: count });
  } catch (error) {
    console.error('Redis error:', error);
    return res.status(500).json({ error: 'Internal Server Error' });
  }
}
