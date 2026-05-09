# CleanCo - Local Backend (Development)

This repository now includes a minimal Node.js + Express backend (SQLite) for local development. It provides API endpoints for products, settings and contact messages and serves uploaded images from `/uploads`.

Quick start (macOS / zsh):

1. Install dependencies:

```bash
cd "/Users/monish_surisetty/Library/CloudStorage/OneDrive-HCLHealthcare/Desktop/HTML/My Learnings/cleankard"
npm install
```

2. Start the server:

```bash
npm start
```

The server will run at http://localhost:3000 by default.

API highlights

- GET /api/products — list products
- POST /api/products — add product (form-data: image file under `image`, other fields as text)
- DELETE /api/products/:id — delete product

- GET /api/settings — get settings
- POST /api/settings — update settings (supports file fields `hero` and `about`).

- GET /api/contacts — list contact submissions
- POST /api/contacts — submit a contact message (JSON body)

Notes

- File uploads are stored in `/uploads` and served statically.
- Multer file size limit is currently set to 1MB. Adjust `server.js` if you need larger uploads.
- This is a development server for local use only. For production you should add authentication, input validation, and secure file handling.
