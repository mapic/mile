### Configure access details for test
```bash
cp test/utils/access.template.json test/utils/access.private.json
nano test/utils/access.private.json # add your credentials and save
```

### Run tests
`docker exec -it dev_pile_1 mocha test/datacube.test.js`

`mapic test mile` 
 - OR -
 `mapic run mile mocha test/mask.test.js` 


```
# example output

  Cubes
      ✓ should create empty cube @ /v2/cubes/create
      ✓ should create cube with options @ /v2/cubes/create
      ✓ should create cube with a dataset @ /v2/cubes/create
      ✓ should get cube by cube_id @ /v2/cubes/get
      ✓ should add dataset @ /v2/cubes/add
      ✓ should remove dataset @ /v2/cubes/remove
      ✓ should update cube @ /v2/cubes/update
      ✓ should upload dataset @ /v2/data/import (205ms)
      ✓ should upload second dataset @ /v2/data/import
      ✓ should add dataset to cube @ /v2/cubes/add
      ✓ should add second dataset to cube @ /v2/cubes/add
      ✓ should process raster (2580ms)
      
      ...

  35 passing (12s)
  1 pending

```
