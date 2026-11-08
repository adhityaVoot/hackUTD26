# Enable Google sign-in

The sign-in screen offers Google and household name/invitation/PIN access. Google is disabled by default because the provider is not configured yet.

1. Create a Google OAuth web client in Google Cloud. Set its redirect URI to `https://auth.spacetimedb.com/interactions/federated/callback/google`.
2. Enable Google in the SpacetimeAuth project's Identity Providers settings using that Google client ID and secret. Keep the secret there, never in VITE variables.
3. Register the exact app callback and logout URLs in the existing SpacetimeAuth client:
   - `https://tandem-app.us/callback` and `https://tandem-app.us`
   - Local testing: `http://127.0.0.1:5174/callback` and `http://127.0.0.1:5174` (also add localhost if used).
   - Existing port 5173 addresses remain supported. Register www separately only if serving the app there rather than redirecting it.
4. Set `VITE_GOOGLE_SIGN_IN_ENABLED=true` in Vercel environment variables and redeploy. For local testing, set it in gitignored `.env.local` and restart Vite.
5. Click Continue with Google, then select Google on the hosted SpacetimeAuth sign-in page. The frontend intentionally uses the normal OIDC flow instead of an undocumented provider-specific shortcut. After returning, join/create the household if no membership is linked.

`vercel.json` serves the SPA at `/callback`. The frontend continues connecting with the SpacetimeAuth ID token. No Supabase integration is needed.

The household-details path is the hackathon demo identity flow. Existing PINs are verified before the new sign-in action claims membership. First-time PIN creation is explicit and cannot overwrite an existing PIN. This does not replace production identity verification or recovery design; legacy household join endpoints retain their existing behavior.

Reference: https://spacetimedb.com/docs/core-concepts/authentication/spacetimeauth/configuring-a-project/

Successful callbacks now land on Overview. New authenticated users see empty-household onboarding, not another login prompt. OIDC transaction/PKCE state is shared through localStorage so magic links can return in another tab; user tokens remain in sessionStorage. Use the same browser profile and exact origin when opening the email link. Start a fresh sign-in after this update; earlier in-progress links may lack the new transaction state.
