# Vendor sign-in

Each vendor connects through its own sign-in where it offers one to other
apps, and through its API key where it does not. Today that is the Studio plan
sign-in for Claude models, and an API key for Anthropic, OpenAI and Google.

## Where each vendor stands

- **OpenAI.** Sign in with ChatGPT lets a user's ChatGPT plan pay for model
  calls in another app (OAuth with PKCE against `auth.openai.com`, inference on
  the Responses API). The self-serve path is for open-source and locally hosted
  apps; paid apps go through a waitlist for commercial partners. Studio is paid
  and closed source, so it needs a client id from that waitlist.
  Docs: https://developers.openai.com/siwc
- **Anthropic.** No sign-in for third-party apps. Plan tokens are reserved for
  Anthropic's own products. The Studio plan (gateway) is the sign-in for Claude
  models.
- **Google.** The Gemini API takes OAuth user credentials, but through a Google
  Cloud OAuth client: the consent screen needs Google's verification for a
  public app, and requests bill the client's project, not the user's. That is
  not a sign-in to the user's own Google plan.
  Docs: https://ai.google.dev/gemini-api/docs/oauth

## TODO

- [ ] Submit the Sign in with ChatGPT interest form for UE-MCP Studio
      (https://openai.com/form/sign-in-with-chatgpt-interest/) and get an
      `oaiapp_` client id.
- [ ] Read the ChatGPT plan usage pages (models and inference, token reference,
      preview limitations) once access is granted.
- [ ] Add a `chatgpt` sign-in: loopback listener on `127.0.0.1`, PKCE, state and
      nonce, the token exchange, ID token validation against OpenAI's JWKS,
      and a check that `chatgpt.tokens.use.direct` was granted.
- [ ] Store the access and refresh tokens as secrets and refresh them before
      expiry.
- [ ] Add a Responses API provider beside the Chat Completions one, streaming,
      with `store: false`.
- [ ] List `chatgpt` as the sign-in for OpenAI models in the picker, ahead of the key.
- [ ] Check again whether Anthropic offers a third-party sign-in. Until it does,
      the Studio plan is the only sign-in for Claude models.
- [ ] Check again whether Google offers a sign-in that bills the user's own
      plan, and add it ahead of the key when it does.
- [ ] Studio plan: add OpenAI and Google models to the gateway, so the Studio
      sign-in runs them without waiting on either vendor.
