#!/bin/sh
set -e

cd /opt/application
export PORT="${PORT:-8000}"
exec npm start
