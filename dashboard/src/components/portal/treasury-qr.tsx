"use client";

import { QRCodeSVG } from "qrcode.react";

/** Scannable QR. Payment screens encode the treasury address. Pairing encodes the Binance sign-in link. */
export function TreasuryQr({
  value,
  title = "QR code of the treasury address",
  size = 132,
}: {
  value: string;
  title?: string;
  size?: number;
}) {
  return (
    <div className="w-fit rounded-xl bg-white p-2.5">
      <QRCodeSVG
        value={value}
        size={size}
        level="M"
        marginSize={1}
        bgColor="#ffffff"
        fgColor="#07140e"
        title={title}
      />
    </div>
  );
}
