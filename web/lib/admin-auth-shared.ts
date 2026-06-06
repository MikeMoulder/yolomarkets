// Shared between client and server so the exact signed message stays identical.

export function buildAdminLoginMessage(
    address: string,
    nonce: string,
    issuedAt: string,
): string {
    const normalizedAddress = address.toLowerCase();
    return [
        "YOLO Markets — Admin Authentication",
        "",
        `Wallet:   ${normalizedAddress}`,
        `Nonce:    ${nonce}`,
        `Issued:   ${issuedAt}`,
        "Expires:  in 5 minutes",
        "",
        "By signing this message you authorize a 1-hour admin session.",
        "This signature is OFF-CHAIN and does not move any funds.",
        "If you did not initiate this login, reject the request.",
    ].join("\n");
}
