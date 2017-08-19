#!/bin/bash

# get code
MILE_BRANCH=${MAPIC_MILE_BRANCH:-master}
echo "MILE_BRANCH: $MILE_BRANCH"
mkdir -p /mapic && cd /mapic
git clone https://github.com/mapic/mile.git
cd /mapic/mile
git checkout MILE_BRANCH

# ensure log folder
mkdir -p /mapic/mile/log

# yarn
yarn config set cache-folder /mapic/mile/.yarn
yarn install

# clean up forever
rm -rf /root/.forever

# spin server
forever -m 100 --spinSleepTime 1000 -f -v -w --watchDirectory src/ src/mile.js
