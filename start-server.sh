#!/bin/bash

# go to folder
cd /mapic/mile

# ensure log folder
mkdir -p /mapic/mile/log

# get latest
git pull origin master
git checkout ${MAPIC_MILE_BRANCH:-master}

# yarn
yarn config set cache-folder /mapic/mile/.yarn
yarn install

# clean up forever
rm -rf /root/.forever

# spin server
forever -m 100 --spinSleepTime 1000 -f -v -w --watchDirectory src/ src/mile.js
