/** Public Cap credentials/OAuth provisioning is retired. Existing sessions,
 * recordings and logout remain available; Calari owns all new sign-ins. */
export function publicCredentialAuthClosed() {
  return Response.json(
    {
      error: {
        code: "CALARI_SIGN_IN_REQUIRED",
        message: "Use your existing Calari account to sign in.",
      },
      signInUrl: "/portal",
    },
    { status: 410, headers: { "cache-control": "no-store" } },
  );
}
