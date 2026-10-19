# Vendor sign-in

Each vendor connects through its own sign-in where it offers one to other
apps, and through its API key where it does not.

## Where each vendor stands

- **OpenAI.** Sign in with ChatGPT lets a user's ChatGPT plan pay for model
  calls in another app (OAuth with PKCE against `auth.openai.com`, inference on
  the Responses API). Open-source, locally hosted apps register themselves
  through a self-serve path, which is the one Studio takes.
  Docs: https://developers.openai.com/siwc
- **Anthropic.** Apps built on the Claude Agent SDK may run on the user's
  Claude subscription limits. The sign-in must complete through Anthropic's own
  flow in the unmodified runtime binary, and the app may not collect, store or
  intermediate the credentials. Studio offers it as an opt-in sign-in beside the
  API key: the runtime's `auth login`, `auth status` and `auth logout` do all
  of it, with no input or output connected to Studio.
  Docs: https://code.claude.com/docs/en/legal-and-compliance
- **Google.** The Gemini API takes OAuth user credentials only through a Google
  Cloud OAuth client whose project is billed, which is not a sign-in to the
  user's own plan. The API key is the way in.
  Docs: https://ai.google.dev/gemini-api/docs/oauth

## TODO

- [x] Add a `chatgpt` sign-in through the open-source path: first sign-in with
      `dynamic_agent_client` and a stable `ext_agent_host_id`, then keep the
      issued `oaiapp_` client id per account. Loopback listener on
      `127.0.0.1`, PKCE, state and nonce, the token exchange, ID token
      validation against OpenAI's JWKS, and a check that
      `chatgpt.tokens.use.direct` was granted.
- [x] Store the access and refresh tokens as secrets and refresh them before
      expiry.
- [x] Add a Responses API provider beside the Chat Completions one, streaming,
      with `store: false`.
- [x] List `chatgpt` as the sign-in for OpenAI models in the picker, ahead of
      the key.
- [ ] Sign in with a real ChatGPT account and run a turn with tool calls.
- [ ] Check again whether Anthropic or Google offers a sign-in to the user's own
      plan, and add it ahead of the key when one does.
