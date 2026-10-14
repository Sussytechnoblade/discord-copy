# PUSDSMP

A Discord-inspired community server with persistent accounts, shared channels and messages, role management, and WebRTC voice rooms.

## Run locally

Requires Node.js 20 or newer.

```sh
npm install
npm start
```

Open `http://localhost:3000`. The first account created becomes the server owner. Other people can join through the same hosted URL and create their own accounts. The server stores its data in `data/pusdsmp.json`; that directory is ignored by Git. Back up that file to preserve accounts, messages, roles, and server settings
Only the first account is the owner/admin by default; later signups receive the Member role. Server managers can mention everyone with `@everyone` or a role by typing its exact name, such as `@Builder`. The server rejects role and everyone mentions from regular members.

## Voice chat

Voice rooms use WebRTC peer-to-peer audio. Allow microphone access when prompted. Microphone access requires HTTPS on hosted sites; localhost is allowed for development. The app uses a public STUN server for connection setup. Some routers and corporate networks require a TURN relay, which this starter does not configure, so calls may not connect on every network. For a public deployment, use HTTPS and configure a TURN service.

## Deployment notes

Keep `data/pusdsmp.json` on persistent storage and restrict access to it. The server hashes passwords with scrypt and uses revocable, HttpOnly, SameSite session cookies. Put the app behind HTTPS before sharing it publicly. This is a small single-server starter, not a horizontally scaled production chat service; WebSocket presence and voice signaling are held in server memory.