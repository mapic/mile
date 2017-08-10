#!/bin/bash

. `dirname $0`/run_in_docker.inc

if [ -z "$3" ]; then
	echo "Must provide database as first argument,"
	echo ""
	echo "Usage: $0 <database> <table> <column> [<num_buckets>] [bar]"
  echo " Pass 'bar'  if you want to show bar in console"
	exit 1
fi

BUCKETS=50
test -n "$4" && BUCKETS=$4

# get config
# source /mapic/config/env.sh || exit 1
MAPIC_PGSQL_USERNAME=systemapic
MAPIC_PGSQL_PASSWORD=docker

# set -f
if [ "$5" == "bar" ]; then

	# with bars (for terminal fun)
	PGPASSWORD=$MAPIC_PGSQL_PASSWORD psql -U $MAPIC_PGSQL_USERNAME -d $1 -h postgis -c 'with column_stats as (
	    select min("'$3'") as min,
	           max("'$3'") as max
	      from '$2'
	),
	     histogram as (
	   select width_bucket("'$3'", min, max, '$BUCKETS') as bucket,
	          int8range(min("'$3'")::int, max("'$3'")::int, '"'"'[]'"'"') as range,
	          min("'$3'") as range_min,
	          max("'$3'") as range_max,
	          count(*) as freq
	     from '$2', column_stats
	 group by bucket
	 order by bucket
	)
	select bucket, range, freq, range_min, range_max, repeat('"'"'*'"'"', (freq::float / max(freq) over() * 30)::int) as bar from histogram;'

else 

	PGPASSWORD=$MAPIC_PGSQL_PASSWORD psql -U $MAPIC_PGSQL_USERNAME -d $1 -h postgis -c 'select row_to_json(t) from (with column_stats as (
	    select min("'$3'") as min,
	           max("'$3'") as max
	      from '$2'
	),
	     histogram as (
	   select width_bucket("'$3'", min, max, '$BUCKETS') as bucket,
	          int4range(min("'$3'")::int, max("'$3'")::int, '"'"'[]'"'"') as range,
	          min("'$3'") as range_min,
	          max("'$3'") as range_max,
	          count(*) as freq
	     from '$2', column_stats
	 group by bucket
	 order by bucket
	)
	select bucket, range, freq, range_min, range_max from histogram) t;'
fi

