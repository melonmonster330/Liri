# Liri for Samsung TV

Initial hardware target: **Samsung The Frame QN65LS03BAFXZA** (2022,
Tizen 6.5, Chromium 85, 1920×1080 TV application canvas).

This directory packages Liri's shared `tv.html` receiver as a Tizen home-screen
application. Do not edit `dist/index.html`; regenerate it from the repository
root with:

```sh
npm run tv:build
```

## Install on the QN65LS03BAFXZA development TV

1. Put the TV and Mac on the same local network and note the Mac's LAN IP.
2. On the TV, open **Apps**, scroll to **App Settings**, and enter `12345` on
   the remote/on-screen keypad.
3. Switch **Developer mode** on, enter the Mac's LAN IP, accept, and reboot the
   TV. After reboot, the Apps screen should say **Develop Mode**.
4. Install Tizen Studio plus **TV Extensions 6.5 or higher**, **Samsung
   Certificate Extension**, and the Web CLI tools.
5. Create a Samsung author/distributor certificate profile and safely back it
   up. Every future update must use the same author certificate.
6. Open Tizen Studio's Device Manager, add the TV's IP on port `26101`, connect,
   then choose **Permit to install applications** for the connected TV.
7. Build `samsung-tv/dist` as a signed `.wgt`, install it, and launch Liri.

The development package targets Tizen 6.5. A later store package can lower its
minimum version after testing if we choose to support older Samsung model years.

## Store preparation

Before Seller Office submission, replace the provisional application/package
IDs if needed, validate the oldest selected model group, create store artwork
and screenshots, and complete Samsung's UI-description and launch checklists.
