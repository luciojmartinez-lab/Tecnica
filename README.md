# Tecnica

PWA para controlar entrenos de tecnica de salto: tests, triples, longitud y altura.

## Datos

- Los datos iniciales se cargan desde `seed-data.js`, generado a partir de `Tests_y_Triples_2025 (3).xlsx`.
- La app guarda los cambios en el navegador y permite exportar/importar backup JSON o CSV.
- Cada jornada admite varios intentos por columna y los graficos usan la mejor marca diaria.

## Netlify

La sincronizacion usa la funcion `GET/POST /api/sync` y Netlify Blobs. En la app se introduce una clave privada; esa clave se hashea en la funcion y se usa para localizar el backup remoto.

No hace falta crear base de datos ni poner la clave en el repositorio. Al enlazar GitHub con Netlify, Netlify instalara `@netlify/blobs` y desplegara la funcion.
