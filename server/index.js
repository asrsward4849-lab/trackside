import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import mongoose from 'mongoose';
import trainsRouter from './routes/trains-next.js';

const app = express();
const port = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());
app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));
app.use('/api/trains', trainsRouter);
app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(error.statusCode || 502).json({ error: error.message || 'Train data is temporarily unavailable.' });
});

if (process.env.MONGODB_URI) {
  mongoose.connect(process.env.MONGODB_URI)
    .then(() => console.log('MongoDB connected'))
    .catch((error) => console.error('MongoDB connection failed:', error.message));
}

app.listen(port, () => console.log(`API listening on http://localhost:${port}`));