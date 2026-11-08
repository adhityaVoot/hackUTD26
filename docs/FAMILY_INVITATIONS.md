# Family invitations

Google/email-created households use email invitations. Creating an invitation does not create a family member or grant access. The recipient signs in with the same verified email, reviews the invitation, creates a PIN, and explicitly accepts. Only then does the backend create their person/membership. No dummy accounts or transactions are created.

Existing authenticated owners can switch their household to invitation-only by creating their first invitation. Existing members are retained. Anonymous demo households retain their name/code/PIN setup. The generic add-person and name/code join reducers reject invitation-only households.

## Current UI

- Owner: Overview → Invite family, or Accounts → Manage accounts, bills & goals → People.
- Enter name, email, and member/co-owner role. PIN verification is required.
- Pending invitations appear separately from current family members, with delivery status, revoke, and resend.
- Recipient: sign in normally through Google or the email magic link. Invitations matching the verified email appear on Overview, including before household setup.
- Accept & join creates membership; decline, revoke, expiry, and replay are enforced by the backend.

## One-time email delivery setup

SpacetimeAuth sends authentication emails, not custom invitation messages. The included sender uses Resend; it requires a separate sender setup.

1. Create a Resend account at https://resend.com and verify a sending domain you own, such as `tandem-app.us`. Add exactly the DNS records Resend provides in Porkbun. Keep your Vercel website records.
2. Create a sending API key. Put these server-only values in the gitignored Spacetime configuration (or publish-time server environment):

```dotenv
RESEND_API_KEY=your_private_resend_key
INVITE_FROM_EMAIL=Tandem <invites@your_verified_domain>
APP_PUBLIC_URL=https://tandem-app.us
AUTH_CLIENT_ID=client_034tn4mKpPebmrzFj9lznr
```

For local testing on this computer use `APP_PUBLIC_URL=http://127.0.0.1:5174`. For the public site, publish the same module and server configuration to Maincloud and use `APP_PUBLIC_URL=https://tandem-app.us`, so the email link and invitation data point to the same environment.

Never put the key into VITE variables or GitHub. Publish the backend after configuring it.

Without a sender key/address, invitations are saved as `not_configured` and the UI says no email was sent. The recipient can still sign in with the invited email and find the pending invitation in-app. After sender setup, resend the pending invitation. The app does not pretend to send an email or create fake verification links.

## Security and operational behavior

- Invitations match server-validated SpacetimeAuth issuer, audience, and `email_verified` claims; browser-supplied email addresses are not authentication proof.
- The client-connected hook records the verified email for caller-filtered inbox views.
- Expiry is 7 real days, independent of simulated financial time.
- Roles are fixed by the invitation, not chosen by the recipient.
- Acceptance is transactional and single-use. Forwarding a link to another email does not authorize joining.
- A pending invitation can be revoked; sending and resending use scheduled procedures and provider idempotency keys.
- An authenticated identity currently belongs to one household. Acceptance is blocked if already a member elsewhere; household switching is separate future work.
- A provider-accepted email is labeled sent; delivery/bounce webhooks are not implemented.
- A verified email claim must be present in SpacetimeAuth's ID token. If your provider omits it, configure the identity provider's claim mapping instead of weakening the email check.

Reference: https://resend.com/docs/api-reference/emails/send-email
