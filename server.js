require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const multer = require('multer');
const cloudinary = require('cloudinary').v2;
const { Resend } = require('resend');

const app = express();
const PORT = process.env.PORT || 5000;

// Multer memory storage
const upload = multer({ storage: multer.memoryStorage() });

// Cloudinary setup
const hasCloudinary = process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET;
if (hasCloudinary) {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET
  });
}

// Resend setup
const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// PostgreSQL Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://furniture_leads_user:nByNTJaXIDN6fwsehmaRUUuebwdg99VJ@dpg-dat7m6l9fdbs7381bbjg-a.oregon-postgres.render.com/furniture_leads',
  ssl: { rejectUnauthorized: false }
});

// Auto-migration: Ensure required columns exist and drop strict constraints
async function initDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS furniture_leads (
        id SERIAL PRIMARY KEY,
        full_name VARCHAR(255),
        email VARCHAR(255),
        created_at TIMESTAMP DEFAULT NOW()
      );
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS phone_number VARCHAR(255);
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS phone VARCHAR(255);
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS location VARCHAR(255);
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS category VARCHAR(255);
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS furniture_type VARCHAR(255);
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS material VARCHAR(255);
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS dimensions TEXT;
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS details TEXT;
      ALTER TABLE furniture_leads ADD COLUMN IF NOT EXISTS image_url TEXT;

      -- Drop strict NOT NULL constraints on optional columns if present
      ALTER TABLE furniture_leads ALTER COLUMN furniture_type DROP NOT NULL;
      ALTER TABLE furniture_leads ALTER COLUMN phone_number DROP NOT NULL;
    `);
    console.log('✅ PostgreSQL schema verified and synced successfully.');
  } catch (err) {
    console.log('ℹ️ Database sync check finished.');
  }
}
initDatabase();

// Health Check
app.get('/', (req, res) => {
  res.send('Custom Furniture API Backend is running.');
});

// Lead Submission Endpoint
app.post('/api/leads', upload.single('referenceImage'), async (req, res) => {
  try {
    const { 
      fullName, full_name,
      email, 
      phone, contact_info, phone_number,
      location, 
      category, furniture_type, furnitureType,
      material, 
      dimensions, 
      details 
    } = req.body;

    const clientName = fullName || full_name || 'Anonymous';
    const clientContact = phone || contact_info || phone_number || 'N/A';
    const furnitureCategory = category || furniture_type || furnitureType || 'Custom Furniture';
    let imageUrl = null;

    // Image Upload to Cloudinary
    if (req.file && hasCloudinary) {
      try {
        const uploadPromise = new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: 'furniture_leads' },
            (error, result) => {
              if (error) reject(error);
              else resolve(result.secure_url);
            }
          );
          stream.end(req.file.buffer);
        });
        imageUrl = await uploadPromise;
      } catch (uploadErr) {
        console.error('⚠️ Cloudinary upload skipped/failed:', uploadErr);
      }
    }

    // Insert Lead into PostgreSQL with fallbacks for furniture_type and phone_number
    const query = `
      INSERT INTO furniture_leads 
      (full_name, email, phone_number, location, category, furniture_type, material, dimensions, details, image_url, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
      RETURNING *;
    `;
    const values = [
      clientName, 
      email || null, 
      clientContact, 
      location || null, 
      furnitureCategory, 
      furnitureCategory, 
      material || null, 
      dimensions || null, 
      details || null, 
      imageUrl
    ];

    const result = await pool.query(query, values);

    // Send email notification via Resend
    if (resend) {
      try {
        await resend.emails.send({
          from: 'Furniture Leads <onboarding@resend.dev>',
          to: process.env.ADMIN_EMAIL || email,
          subject: `New Custom Furniture Quote Request - ${clientName}`,
          html: `
            <h3>New Lead Received</h3>
            <p><strong>Name:</strong> ${clientName}</p>
            <p><strong>Email:</strong> ${email || 'N/A'}</p>
            <p><strong>Phone/WhatsApp:</strong> ${clientContact}</p>
            <p><strong>Location:</strong> ${location || 'N/A'}</p>
            <p><strong>Category:</strong> ${furnitureCategory}</p>
            <p><strong>Material Finish:</strong> ${material || 'Unspecified'}</p>
            <p><strong>Dimensions:</strong> ${dimensions || 'N/A'}</p>
            <p><strong>Details:</strong> ${details || 'N/A'}</p>
            ${imageUrl ? `<p><strong>Reference Image:</strong> <a href="${imageUrl}" target="_blank">View Reference Image</a></p>` : ''}
          `
        });
      } catch (emailErr) {
        console.error('⚠️ Resend email failed:', emailErr);
      }
    }

    res.status(200).json({ success: true, lead: result.rows[0] });
  } catch (error) {
    console.error('❌ Lead processing error:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});