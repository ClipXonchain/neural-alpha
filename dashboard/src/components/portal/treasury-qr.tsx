"use client";

import { QRCodeSVG } from "qrcode.react";

/** Scannable QR of the treasury address. The payload is the address itself, not a token contract. */
export function TreasuryQr({ value }: { value: string }) {
  return (
    <div className="w-fit rounded-xl bg-white p-2.5">
      <QRCodeSVG
        value={value}
        size={132}
        level="M"
        marginSize={1}
        bgColor="#ffffff"
        fgColor="#07140e"
        title="QR code of the treasury address"
      />
    </div>
  );
}
