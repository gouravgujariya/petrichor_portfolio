# Petrichor Portfolio

A community portfolio site for Petrichor — music, art, and mental health.

## Run locally

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file from the example:

```bash
cp .env.example .env
```

3. Set a strong `ADMIN_PASSWORD` and `SESSION_SECRET` in `.env`.

4. Start the server:

```bash
npm start
```

5. Open the site at `http://localhost:3000`

## Admin panel

- URL: `http://localhost:3000/admin`
- Password: value of `ADMIN_PASSWORD` in your `.env` file
- **Rate limit:** 3 failed login attempts per IP, then locked for 15 minutes
- **Upload:** JPEG, PNG, or WebP event posters (max 8 MB)

Uploaded posters appear on the main site's Events section automatically.
