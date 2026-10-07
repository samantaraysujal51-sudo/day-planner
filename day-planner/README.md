# Day Planner — Student Schedule Planner (TY.CS)

Node.js + Express + MySQL. One web app that works on mobile and laptop browsers.

## A. Run it on your laptop (VS Code)
1. Make sure MySQL Server is running.
2. Open this folder in VS Code → Terminal → run:
   ```
   npm install
   copy .env.example .env        (Mac/Linux: cp .env.example .env)
   ```
3. Open `.env` and put your MySQL password in `DB_PASSWORD`.
4. `npm start` → open http://localhost:3000
   (The database and all tables are created automatically.)

Admin login (change in `.env` BEFORE first start): `admin` / `admin123`

## B. See the database tables in VS Code
1. VS Code → Extensions → install **MySQL** (by Weijan Chen) or **SQLTools + SQLTools MySQL driver**.
2. Add a connection: host `localhost`, port `3306`, user `root`, your password.
3. Open database `day_planner` → tables: `students`, `admins`, `categories`, `tasks`, `task_log`.
   Right-click a table → *Select top 1000* to view the rows.

## C. Make it available to everyone (not only your Wi-Fi)
`localhost` only works on your own laptop. To let anyone open it from any phone or laptop, host it online:
1. **Database:** create a free cloud MySQL (e.g. Aiven, TiDB Cloud, Railway). Note host, port, user, password, db name.
2. **Code:** upload this folder to a GitHub repository (`.env` is ignored, so passwords are not uploaded).
3. **Web app:** create a "Web Service" on Render (or Railway) from that repository.
   Build command: `npm install`  Start command: `npm start`
   Add the same values as in `.env` under *Environment Variables* (use the cloud DB details, `DB_SSL=true`,
   and a strong `ADMIN_PASSWORD` and `JWT_SECRET`).
4. You get a public link like `https://day-planner.onrender.com` — share it with all students.
5. To view the live tables in VS Code, use the same cloud host/user/password in the VS Code MySQL connection (step B).

## Troubleshooting
Always open the app at **http://localhost:3000** after running `npm start` (do not double-click `index.html`).
The login page shows a status line:
- **Red "Server not running"** → run `npm start` in the project folder (after `npm install`).
- **Orange "database is not connected"** → start MySQL and check `DB_USER` / `DB_PASSWORD` in `.env`
  (replace `your_mysql_password` with your real password). The server retries every 5 seconds.
- **Green "Connected"** → create an account or log in.
- Admin password follows `.env` (`ADMIN_USER` / `ADMIN_PASSWORD`): change it there and restart.
- "Port 3000 already in use" → close the other terminal still running the app, or add `PORT=3001` to `.env`.

## Notes
- Phone: exactly 10 digits (letters are blocked). Password: exactly 8 characters. Passwords are stored encrypted (bcrypt).
- Admin can see every student's details and weekly schedule (read-only) and delete accounts.
- Reminders pop up while the app is open in the browser tab.
