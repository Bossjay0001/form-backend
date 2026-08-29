require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const { Pool } = require('pg');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();

app.use(helmet());
app.use(express.json({ limit: '10kb' }));

const corsOptions = {
  origin: process.env.ALLOWED_ORIGIN || '*',
  methods: ['POST', 'GET']
};
app.use(cors(corsOptions));

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { success: false, message: 'Too many submissions. Please try again later.' }
});
app.use('/submit-form', limiter);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

function hashData(data) {
  if (!data) return null;
  const cleanData = data.toString().trim().toLowerCase();
  return crypto.createHash('sha256').update(cleanData).digest('hex');
}

function formatPhone(phone) {
  if (!phone) return null;
  const cleaned = phone.replace(/\D/g, '');
  return cleaned ? cleaned : null;
}

app.post('/submit-form', async (req, res) => {
  const {
    name, email, phone, message, eventId,
    fbp, fbc, userUrl,
    utm_source, utm_medium, utm_campaign, utm_term, utm_content
  } = req.body;

  if (!email || !name || !eventId) {
    return res.status(400).json({ success: false, message: 'Missing required fields.' });
  }

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress;
  const userAgent = req.headers['user-agent'];

  try {
    const insertQuery = `
      INSERT INTO leads 
      (event_id, name, email, phone, message, utm_source, utm_medium, utm_campaign, utm_term, utm_content, fbp, fbc, ip_address, user_agent)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (event_id) DO NOTHING;
    `;
    const dbValues = [
      eventId, name, email, phone, message,
      utm_source || null, utm_medium || null, utm_campaign || null,
      utm_term || null, utm_content || null,
      fbp || null, fbc || null, clientIp, userAgent
    ];
    
    await pool.query(insertQuery, dbValues);

    const hashedEmail = hashData(email);
    const hashedPhone = hashData(formatPhone(phone));
    const nameParts = name.trim().split(' ');
    const hashedFirstName = hashData(nameParts[0]);
    const hashedLastName = nameParts.length > 1 ? hashData(nameParts.slice(1).join(' ')) : null;

    const capiPayload = {
      data: [
        {
          event_name: 'Lead',
          event_time: Math.floor(Date.now() / 1000),
          event_id: eventId,
          event_source_url: userUrl || req.headers.referer,
          action_source: 'website',
          user_data: {
            em: [hashedEmail],
            ph: hashedPhone ? [hashedPhone] : [],
            fn: hashedFirstName ? [hashedFirstName] : [],
            ln: hashedLastName ? [hashedLastName] : [],
            client_ip_address: clientIp,
            client_user_agent: userAgent,
            fbp: fbp || undefined,
            fbc: fbc || undefined
          },
          custom_data: {
            content_name: 'Lead Generation Form',
            utm_source: utm_source
          }
        }
      ]
    };

    const pixelId = process.env.META_PIXEL_ID;
    const accessToken = process.env.META_ACCESS_TOKEN;
    const capiUrl = `https://graph.facebook.com/v19.0/${pixelId}/events?access_token=${accessToken}`;

    const capiResponse = await axios.post(capiUrl, capiPayload);

    await pool.query(
      `UPDATE leads SET meta_capi_status = $1 WHERE event_id = $2`,
      ['SENT_SUCCESS', eventId]
    );

    return res.status(200).json({
      success: true,
      message: 'Form submitted successfully!',
      eventId: eventId,
      capiEventsReceived: capiResponse.data.events_received
    });

  } catch (error) {
    console.error('Submission Error:', error.response?.data || error.message);
    return res.status(500).json({ success: false, message: 'Internal processing error.' });
  }
});
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});