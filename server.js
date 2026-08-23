require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Helper function to SHA-256 hash personal identifiers required by Meta
function hashData(data) {
  if (!data) return null;
  return crypto.createHash('sha256').update(data.trim().toLowerCase()).digest('hex');
}

app.post('/submit-form', async (req, res) => {
  const { name, email, phone, message, eventId } = req.body;

  // 1. Log form submission
  console.log('Received Form Submission:', { name, email, phone, message, eventId });

  // 2. Prepare Meta Conversions API Payload
  const pixelId = process.env.META_PIXEL_ID;
  const accessToken = process.env.META_ACCESS_TOKEN;

  if (pixelId && accessToken) {
    const metaPayload = {
      data: [
        {
          event_name: 'Lead',
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId || `lead_${Date.now()}`,
          action_source: 'website',
          user_data: {
            em: [hashData(email)],
            ph: [hashData(phone)],
            client_ip_address: req.ip,
            client_user_agent: req.headers['user-agent']
          },
          custom_data: {
            content_name: 'Contact Form Submission'
          }
        }
      ]
    };

    try {
      await axios.post(
        `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`,
        metaPayload
      );
      console.log('Successfully sent Lead event to Meta CAPI');
    } catch (error) {
      console.error('Meta CAPI Error:', error.response ? error.response.data : error.message);
    }
  }

  // 3. Send response back to frontend
  res.json({
    success: true,
    message: 'Form submitted successfully!',
    receivedData: { name, email, phone, message, eventId }
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});