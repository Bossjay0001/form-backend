const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Root Route
app.get('/', (req, res) => {
  res.send('Form API is live and running!');
});

// Submit Form Route
app.post('/submit-form', (req, res) => {
  const { name, email, phone, message, eventId } = req.body;

  if (!email || !name) {
    return res.status(400).json({ 
      success: false, 
      error: 'Name and email are required.' 
    });
  }

  console.log(' New Form Submission Received:');
  console.table({ name, email, phone, message, eventId });

  return res.status(200).json({
    success: true,
    message: 'Form submitted successfully!',
    receivedData: { name, email, phone, message, eventId }
  });
});

// Start Server
app.listen(PORT, () => {
  console.log(` Server running on http://localhost:${PORT}`);
});