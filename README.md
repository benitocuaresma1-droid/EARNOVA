# EARNOVA

A mobile-friendly task and rewards website starter built with Node.js, Express and PostgreSQL.

## Included

- Registration with activation code and optional referral code
- Login/logout with server-side sessions
- Server-generated arithmetic, number-sequence and word-check tasks
- Server-side answer validation and point crediting
- 45-second default task cooldown
- Wallet balance and transaction history
- GCash/Maya withdrawal requests with admin review
- Admin dashboard: generate activation codes, list users, ban/unban users, review withdrawals
- Configurable points conversion and reward settings
- Security basics: Helmet, rate limiting, bcrypt password hashes, parameterized SQL

## Important operating notes

This is a deployable starter, not a licensed payment processor. Withdrawals are requests only. An authorized admin must verify the request and arrange payment separately through a legitimate payment channel. Never promise guaranteed income or accept deposits as a condition for earning. Publish clear terms, privacy information, eligibility rules and contact details before inviting users.

The included task rooms are simple knowledge/attention tasks. They do not implement a real CAPTCHA-solving marketplace or third-party task supply. Do not credit users for unverified actions.

## Run locally

1. Install Node.js 20 or newer and PostgreSQL.
2. Create a PostgreSQL database named `earnova`.
3. Copy `.env.example` to `.env`.
4. Set `DATABASE_URL`, a long random `SESSION_SECRET`, `ADMIN_EMAIL`, and a strong `ADMIN_PASSWORD`.
5. Run:

   ```bash
   npm install
   npm start
   ```

6. Open `http://localhost:3000`.

The database tables are created automatically at startup. The first admin account is created if `ADMIN_EMAIL` and `ADMIN_PASSWORD` are set.

## Deploy on Render

1. Push this folder to a GitHub repository.
2. Create a PostgreSQL database in Render.
3. Create a Web Service from the repository (or use the included `render.yaml`).
4. Set `DATABASE_URL` to the Render database's **internal** connection URL when the web service and database are in the same Render region.
5. Set `APP_BASE_URL` to your deployed HTTPS URL.
6. Set a strong `ADMIN_EMAIL` and `ADMIN_PASSWORD`.
7. Ensure `DATABASE_SSL=true` if required by your database provider.
8. Deploy, then visit `/api/health`.

Do not commit `.env` or share admin credentials. Change the initial admin password immediately after deployment.

## Defaults

- ₱3.00 per correct reply
- No points system; direct PHP wallet credits
- No task cooldown or hidden waiting interval
- Minimum withdrawal: ₱50.00
- Referral reward: ₱0.00 by default (referral rewards disabled) to referrer after the new member registers with a valid activation code

Change these values in the Render environment settings or `.env`. The UI reads the current settings from the server.

## Admin

Use the admin credentials configured in environment variables. From the Admin tab you can:
- Generate single-use activation codes
- View registered accounts
- Ban or unban accounts
- Approve or reject withdrawal requests

Admin approval only marks a request approved; it does not send money automatically. Record actual payment details separately and securely.

## Before public launch

- Add your own Terms of Service and Privacy Policy and have them reviewed.
- Configure database backups and monitoring.
- Add email verification and password reset.
- Add stronger fraud prevention and task review.
- Confirm compliance with applicable Philippine laws, consumer protection rules, privacy requirements and payment-provider terms.
- Do not use fabricated testimonials, fake balances, or misleading earning claims.
