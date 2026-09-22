# nadir

A browser tool for georeferencing nadir drone photos (camera pointing straight down).

Open `index.html` in a browser. No build step or server is needed, and images never leave your machine.

- **Control points:** click a spot in the image and enter its latitude/longitude. Google Maps format (`61.128514, 14.535017`) and DMS (`61°7'42.65"N 14°32'6.06"E`) both work. From the third point on, residuals show how well the points agree.
- **Query:** once there are two or more control points, click anywhere to read its coordinates. You can copy them or open them in Google Maps. **Find** goes the other way and marks a coordinate in the image.
- **Labels:** name a location with a coloured pill, ellipse or box that points to it. Drag labels to place them, then export the labelled image as a JPEG.

The transform models are similarity (≥2 points, right for a true nadir shot), affine (≥3) and projective (≥4, corrects a slightly tilted camera).

Work is autosaved in the browser for each image. It can also be saved or loaded as a `.json` project file.

Built with jQuery and Bootstrap. The coordinate maths is in `js/georef.js`.
