# AMR GeoMapper Documentation

AMR GeoMapper (AGM) is a web component for visualizing Antimicrobial Resistance (AMR) data on an interactive map. It displays genomic data geographically, provides filtering and charting capabilities, and supports loading user-provided CSV data for comparison.

The primary public deployment is at [camra.acegid.org/amr-geomapper](https://camra.acegid.org/amr-geomapper).

## Quick Links

| I want to...                        | Go to                                    |
| ----------------------------------- | ---------------------------------------- |
| Load my own CSV data into the tool  | [User Data Guide](user-data-guide.md)    |
| Run AGM on my local machine         | [Local Deployment](local-deployment.md)  |
| Embed AGM in my own website         | [Web Integration](web-integration.md)    |
| Learn how the codebase is organized | [Architecture Overview](architecture.md) |

## File Index

| File                                         | Description                                                    |
| -------------------------------------------- | -------------------------------------------------------------- |
| [`user-data-guide.md`](user-data-guide.md)   | CSV format, column dictionary, validation, and common pitfalls |
| [`local-deployment.md`](local-deployment.md) | Prerequisites, installation, build, and server startup         |
| [`web-integration.md`](web-integration.md)   | Embedding the `<amr-geo-mapper>` component in another project  |
| [`configuration.md`](configuration.md)       | Complete `config.json` schema reference                        |
| [`architecture.md`](architecture.md)         | Code overview, module descriptions, data flow                  |
| [`data-api.md`](data-api.md)                 | API contract for the `/data` endpoint                          |
