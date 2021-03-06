#!/bin/bash

if [ -z "$2" ]; then
	echo "Usage: $0 <database> <table> [<column>]"
	exit 1
fi

DATABASE=$1
TABLE=$2
COL=the_geom_3857
test -n "$3" && COL="$3"

export PGPASSWORD=$MAPIC_POSTGIS_PASSWORD
export PGUSER=$MAPIC_POSTGIS_USERNAME
export PGHOST=$MAPIC_POSTGIS_HOST
export PGDATABASE=$DATABASE

cat<<EOF | psql
SELECT ST_EXTENT(ST_Transform(ST_Envelope("$COL"),3857)) FROM "$TABLE";
EOF
