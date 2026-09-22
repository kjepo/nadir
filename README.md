# nadir

A browser tool for georeferencing nadir drone photos (camera pointing straight down).

Open `index.html` in a browser. No build step or server is needed, and images never leave your machine.

- **Control points:** click a spot in the image and enter its latitude/longitude. Google Maps format (`61.128514, 14.535017`) and DMS (`61°7'42.65"N 14°32'6.06"E`) both work. From the third point on, residuals show how well the points agree.
- **Query:** once there are two or more control points, click anywhere to read its coordinates. You can copy them or open them in Google Maps. **Find** goes the other way and marks a coordinate in the image.
- **Labels:** name a location with a coloured pill, ellipse or box that points to it. Drag labels to place them, then export the labelled image as a JPEG.
- **Areas:** draw a polygon, then name and colour it. Once the image is calibrated, its size in m²/ha and its perimeter are shown. Corners can be dragged, added and deleted.

The transform models are similarity (≥2 points, right for a true nadir shot), affine (≥3) and projective (≥4, corrects a slightly tilted camera).

Work is autosaved in the browser for each image. It can also be saved or loaded as a `.json` project file.

## Sharing

**Share** uploads the image and its project data (password-protected) and returns two links:

- a **view link** (`?p=ID`): recipients explore and query; their own changes stay in their browser and can be reverted;
- an **edit link** (`?p=ID#edit=TOKEN`): changes autosave to the server for everyone, with conflict detection.

The server side is `api.php` (PHP 8.3+). Data is stored outside the web root in `/var/lib/nadir` (override with the `NADIR_DATA` environment variable):

```
/var/lib/nadir/config.php          <?php return ['password_hash' => '...'];
/var/lib/nadir/projects/<id>/      meta.json, project.json, image.jpg, history/
```

Set or change the upload password on the server:

```
PW='new password' php -r 'echo "<?php return ".var_export(["password_hash" => password_hash(getenv("PW"), PASSWORD_DEFAULT)], true).";\n";' > /var/lib/nadir/config.php
```

`.user.ini` raises PHP's upload limit to 60 MB for this directory (PHP-FPM).

## Deploy

```
rsync -rt index.html api.php .user.ini css js hetzner3:/var/www/monsym/nadir/
```

Built with jQuery and Bootstrap. The coordinate maths is in `js/georef.js`.
