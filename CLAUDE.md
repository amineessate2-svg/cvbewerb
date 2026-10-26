


# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Auto-CV Bulk Sender is a web application for sending personalized job application emails (mainly for German "Pflege" - healthcare sector). It supports:
- **Multi-user access** with admin panel (user management, plan limiting)
- **Gmail SMTP integration** via nodemailer
- **Bulk email sending** with recipient database management
- **CV file upload** (PDF, DOC, DOCX) stored locally

## Architecture

### Backend (server.js)
- Express.js server running on port 3000
- Admin passcode: `Amine@0105` (default, configurable in admin panel)
- User plans: `trial` (3h), `1month` (50 DH, 100/day), `2month` (99 DH, 200/day), `vip` (200 DH, unlimited)

### Frontend (public/index.html)
- Tailwind CSS for styling (dark theme, gradient accents)
- Chart.js for admin analytics
- Direct API calls to local Express server

### Data Storage (data/)
- `data/cv.json` - CV file metadata
- `data/cv/` - Uploaded CV files
- `data/pflege_emails_database.json` - Recipient database
- `data/pflege_recipients_list.txt` - Text backup of recipients
- `data/users.json` - User accounts, requests, activities, payments
- `data/stats.json` - Daily sending statistics

## Commands

| Command | Description |
|---------|-------------|
| `npm start` | Start server + auto-open browser |
| `node server.js --verify` | Test SMTP connection only |
| `start.bat` | Windows launcher script |

## Key Endpoints

- `/api/access-request` - Submit user request (auto-activates 3h trial)
- `/api/user/login` - User authentication
- `/api/user/me` - Get current user status & limits
- `/api/admin/login` - Admin login
- `/api/admin/approve` - Approve user request
- `/api/admin/data` - Get all users, requests, stats
- `/api/admin/emails` - Manage recipient database
- `/api/status` - Get Gmail connection status + user limits
- `/api/presets/pflege` - Get filtered email list for bulk sending
- `/api/send` - Send one personalized email
- `/api/cv` - Upload/manage CV files

## Developer Notes

- SMTP credentials stored in `.env` (GMAIL_USER, GMAIL_APP_PASS)
- Email database supports categories: "Gesundheit & Pflege", "Wirtschaft & Logistik"
- Admin panel accessible after first user request or direct login
- All API responses are JSON (never HTML 404 on /api routes)
- Browser only - no build step required
