import mongoose from 'mongoose';

const trainSchema = new mongoose.Schema({
  trainId: { type: String, unique: true, required: true },
  line: { type: String, required: true },
  destination: { type: String, required: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  status: { type: String, default: 'On time' },
  speedKph: { type: Number, default: 0 },
  observedAt: { type: Date, default: Date.now },
});

export default mongoose.model('Train', trainSchema);