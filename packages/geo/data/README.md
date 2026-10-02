# Geodata

| File | What | Used by |
|---|---|---|
| `gazetteer.json` | 5,756 settlements with oblast, class, population, coordinates (OSM) | worker: seeds `toponyms` on an empty database |
| `raions.geojson` | 161 raion polygons, full detail | worker: which raion a user is in |
| `map-regions.geojson` | Simplified oblasts and raions for the map, ~38 KB gzipped | API: `/api/regions.geojson` |

`map-regions.geojson` is built from `raions.geojson`, plus Kyiv city, which belongs to
no raion and so has no polygon there — without it an alert over Kyiv would paint
nothing. Feature properties: `id` (`oblast:<key>` or `raion:<oblast>:<raion>`),
`kind`, `oblast`, `name`. Rebuild:

```bash
npx mapshaper@0.7.72 raions.geojson -simplify 3% keep-shapes \
  -each "kind='raion', id='raion:'+oblast+':'+match" -o raions-s.json precision=0.001
npx mapshaper@0.7.72 raions.geojson -dissolve oblast -simplify 3% keep-shapes \
  -each "kind='oblast', id='oblast:'+oblast" -o oblasts-s.json precision=0.001
# Kyiv city, OSM relation 421866, simplified by Nominatim:
curl -A "<your app>" "https://nominatim.openstreetmap.org/lookup?osm_ids=R421866&format=geojson&polygon_geojson=1&polygon_threshold=0.003"
```

then merge the three into one FeatureCollection (oblasts first, Kyiv as
`oblast:kyiv`). Do not add mapshaper's `-clean`: it silently dropped 8 raions.
