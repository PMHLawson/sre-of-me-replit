#!/bin/bash
set -e

npm install --no-audit --no-fund
npm run db:push -- --force
