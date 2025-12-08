const express = require('express');
const cors = require('cors');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const prisma = new PrismaClient();
const PORT = 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';

app.use(cors());
app.use(express.json());

// ---------- Helpers ----------
function generateToken(user) {
  return jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });
}

async function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing auth token' });
  }
  const token = header.split(' ')[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.userId;
    next();
  } catch (err) {
    console.error('JWT error:', err);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Seed initial data if database is empty
async function seedIfEmpty() {
  const count = await prisma.review.count();
  if (count === 0) {
    await prisma.review.createMany({
      data: [
        {
          platform: 'Google',
          author: 'John D.',
          rating: 2,
          text: 'Food was okay but the service was really slow.',
          date: new Date('2025-12-05')
        },
        {
          platform: 'Yelp',
          author: 'Sarah K.',
          rating: 5,
          text: 'Amazing experience! Great staff and delicious food.',
          date: new Date('2025-12-04')
        },
        {
          platform: 'Facebook',
          author: 'Mike R.',
          rating: 3,
          text: 'Decent place, but the music was too loud for me.',
          date: new Date('2025-12-03')
        }
      ]
    });
    console.log('Seeded initial reviews into the database.');
  }
}

// ---------- AUTH ROUTES ----------

// POST /auth/signup  { email, password }
app.post('/auth/signup', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password || password.length < 6) {
      return res
        .status(400)
        .json({ error: 'Email and password (6+ chars) are required.' });
    }

    const existing = await prisma.user.findUnique({ where: { email } });
    if (existing) {
      return res.status(400).json({ error: 'Email already in use.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        email,
        passwordHash
      }
    });

    const token = generateToken(user);
    res.json({
      token,
      user: { id: user.id, email: user.email }
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ error: 'Failed to sign up' });
  }
});

// POST /auth/login  { email, password }
app.post('/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res
        .status(400)
        .json({ error: 'Email and password are required.' });
    }

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    const token = generateToken(user);
    res.json({
      token,
      user: { id: user.id, email: user.email }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Failed to log in' });
  }
});

// ---------- REVIEW ROUTES (protected) ----------

// CREATE review: POST /api/reviews
app.post('/api/reviews', authMiddleware, async (req, res) => {
  try {
    const { platform, author, rating, text, date } = req.body;

    if (!platform || !text) {
      return res
        .status(400)
        .json({ error: 'Platform and text are required.' });
    }

    const newReview = await prisma.review.create({
      data: {
        platform,
        author: author || 'Anonymous',
        rating: Number(rating) || 5,
        text,
        date: date ? new Date(date) : new Date(),
        userId: req.userId
      }
    });

    res.json(newReview);
  } catch (err) {
    console.error('Error creating review:', err);
    res.status(500).json({ error: 'Failed to create review' });
  }
});

// READ reviews: GET /api/reviews
app.get('/api/reviews', authMiddleware, async (req, res) => {
  try {
    const reviews = await prisma.review.findMany({
      where: {
        OR: [{ userId: req.userId }, { userId: null }] // show user-owned + seeded demo reviews
      },
      orderBy: { date: 'desc' }
    });
    res.json(reviews);
  } catch (err) {
    console.error('Error fetching reviews:', err);
    res.status(500).json({ error: 'Failed to fetch reviews' });
  }
});

// UPDATE review: PUT /api/reviews/:id
app.put('/api/reviews/:id', authMiddleware, async (req, res) => {
  const id = Number(req.params.id);
  const { platform, author, rating, text, date } = req.body;

  try {
    const updated = await prisma.review.update({
      where: { id },
      data: {
        ...(platform && { platform }),
        ...(author && { author }),
        ...(rating && { rating: Number(rating) }),
        ...(text && { text }),
        ...(date && { date: new Date(date) })
      }
    });

    res.json(updated);
  } catch (err) {
    console.error('Error updating review:', err);
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Review not found' });
    }
    res.status(500).json({ error: 'Failed to update review' });
  }
});

// DELETE review: DELETE /api/reviews/:id
app.delete('/api/reviews/:id', authMiddleware, async (req, res) => {
  const id = Number(req.params.id);

  try {
    await prisma.review.delete({
      where: { id }
    });
    res.json({ success: true });
  } catch (err) {
    console.error('Error deleting review:', err);
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Review not found' });
    }
    res.status(500).json({ error: 'Failed to delete review' });
  }
});

// POST /api/generate-reply - generate a suggested reply
app.post('/api/generate-reply', authMiddleware, async (req, res) => {
  const { reviewId, businessName } = req.body;

  try {
    const review = await prisma.review.findUnique({
      where: { id: reviewId }
    });

    if (!review) {
      return res.status(404).json({ error: 'Review not found' });
    }

    let replyText = `Hi ${review.author || 'there'},\n\n`;

    if (review.rating <= 3) {
      replyText += `Thank you for your feedback and for giving us a chance. We're sorry your experience at ${businessName} didn't fully meet your expectations. `;
      replyText += `We take comments like yours seriously and will use them to improve our service. If you're open to it, please reach out to us directly so we can make this right.\n\n`;
    } else {
      replyText += `Thank you so much for the great review and for taking the time to share your experience at ${businessName}! `;
      replyText += `We're glad you enjoyed your visit and hope to see you again soon.\n\n`;
    }

    replyText += `– The ${businessName} Team`;

    await prisma.review.update({
      where: { id: reviewId },
      data: { lastSuggestedResponse: replyText }
    });

    res.json({ reply: replyText });
  } catch (err) {
    console.error('Error generating reply:', err);
    res.status(500).json({ error: 'Failed to generate reply' });
  }
});

// POST /api/save-reply - save a chosen reply
app.post('/api/save-reply', authMiddleware, async (req, res) => {
  const { reviewId, response } = req.body;

  try {
    const updated = await prisma.review.update({
      where: { id: reviewId },
      data: { response }
    });

    res.json({ success: true, review: updated });
  } catch (err) {
    console.error('Error saving reply:', err);
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Review not found' });
    }
    res.status(500).json({ error: 'Failed to save reply' });
  }
});

app.listen(PORT, async () => {
  console.log(`Backend running on http://localhost:${PORT}`);
  await seedIfEmpty();
});