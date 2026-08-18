-- Additive migration: authentication (users, sessions) and read-only public view links.
-- No existing table, column or data is modified or removed.

CREATE TYPE "Role" AS ENUM ('ADMIN', 'OPERATOR', 'VIEWER');
CREATE TYPE "PublicViewType" AS ENUM ('MAP', 'NOC');

CREATE TABLE "User" (
  "id" TEXT NOT NULL,
  "username" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "passwordHash" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "role" "Role" NOT NULL DEFAULT 'VIEWER',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "Session" (
  "id" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PublicView" (
  "id" TEXT NOT NULL,
  "token" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "type" "PublicViewType" NOT NULL,
  "mapId" TEXT,
  "playlistId" TEXT,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PublicView_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "User_username_key" ON "User"("username");
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
CREATE UNIQUE INDEX "PublicView_token_key" ON "PublicView"("token");
CREATE INDEX "PublicView_mapId_idx" ON "PublicView"("mapId");
CREATE INDEX "PublicView_playlistId_idx" ON "PublicView"("playlistId");

ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicView" ADD CONSTRAINT "PublicView_mapId_fkey" FOREIGN KEY ("mapId") REFERENCES "Map"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PublicView" ADD CONSTRAINT "PublicView_playlistId_fkey" FOREIGN KEY ("playlistId") REFERENCES "MapPlaylist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
