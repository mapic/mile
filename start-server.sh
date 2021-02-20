#!/bin/bash

# go to folder
cd /mapic/mile

# pull latest code
bash scripts/pull-latest-code.sh

# ensure log folder
mkdir -p /mapic/mile/log

# yarn
sudo npm install -g yarn
yarn version
yarn config set cache-folder /mapic/mile/.yarn
yarn install

# clean up forever
rm -rf /root/.forever

UV_THREADPOOL_SIZE=$(getconf _NPROCESSORS_ONLN) # number of CPUs on instance
echo "Setting UV_THREADPOOL_SIZE to numCPUs:  $UV_THREADPOOL_SIZE"
export UV_THREADPOOL_SIZE

# spin server
forever -m 100 --spinSleepTime 1000 -f -v -w --watchDirectory src/ src/mile.js
