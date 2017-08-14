#!/bin/bash

# # source config
# source /mapic/config/env.sh || exit 1

# # TODO: find a better way ?
# export SYSTEMAPIC_PGSQL_USERNAME \
#        SYSTEMAPIC_PGSQL_PASSWORD \
#        SYSTEMAPIC_PGSQL_DBNAME

# ensure log folder
mkdir -p /mapic/mile/log

# yarn
yarn config set cache-folder /mapic/mile/.yarn
yarn install

# ensure 
cd /mapic/mile

# spin server
# if $MAPIC_PRODMODE; then
# 	echo 'Mile | PostGIS Tile Server | Production mode'
# 	forever src/mile.js production >> log/mile.log
# else
# 	echo 'Mile Debug mode (with 8GB memory)'
# 	nodemon --max-old-space-size=8192 -i node_modules/ -i test/ src/mile.js
# fi

forever -c nodemon --exitcrash --max-old-space-size=8192 -i node_modules/ -i test/ src/mile.js