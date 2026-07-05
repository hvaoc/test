import React from 'react';
import { View, Platform } from 'react-native';
import QRCode from 'react-native-qrcode-svg';
import logo from '../../assets/logo.png';

// A custom invite QR: the invite URL encoded as a QR with the app logo centred.
// Uses high error-correction (ecl="H") so the logo cutout doesn't break scanning.
export default function InviteQR({ value, size = 200 }) {
  if (!value) return null;
  return (
    <View
      style={{
        padding: 14,
        backgroundColor: '#ffffff',
        borderRadius: 14,
        alignSelf: 'flex-start',
        ...(Platform.OS === 'web' ? { boxShadow: '0 1px 6px rgba(0,0,0,0.12)' } : null),
      }}
    >
      <QRCode
        value={value}
        size={size}
        color="#111214"
        backgroundColor="#ffffff"
        ecl="H"
        logo={logo}
        logoSize={Math.round(size * 0.24)}
        logoBackgroundColor="#ffffff"
        logoBorderRadius={8}
        logoMargin={4}
      />
    </View>
  );
}
