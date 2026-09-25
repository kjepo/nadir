# nadir

A browser tool for georeferencing nadir drone photos (camera pointing straight down).

Open `index.html` in a browser. No build step or server is needed, and images never leave your machine.

- **Control points:** click a spot in the image and enter its latitude/longitude. Google Maps format (`61.128514, 14.535017`) and DMS (`61°7'42.65"N 14°32'6.06"E`) both work. From the third point on, residuals show how well the points agree.
- **Query:** once there are two or more control points, click anywhere to read its coordinates. You can copy them or open them in Google Maps. **Find** goes the other way and marks a coordinate in the image.
- **Labels:** name a location with a coloured pill, ellipse or box that points to it. Drag labels to place them, then export the labelled image as a JPEG.
- **Areas:** draw a polygon, then name and colour it. Once the image is calibrated, its size in m²/ha and its perimeter are shown. Click an area to see its size. Corners can be dragged, added and deleted.
- **Measure:** click along a route to get its length and each segment's length and compass bearing. Measurements are kept with a length label and can be reshaped.
- **Map overlay:** a toggle that draws OpenStreetMap roads, paths, buildings and water over the calibrated photo. It's also a quick calibration check. The data is fetched through `api.php?action=osm` from Overpass, trimmed to the photo's surroundings, and cached for 30 days in `/var/lib/nadir/osm`.
- **Locate me:** shows your live GPS position on the photo, with an accuracy circle. This needs HTTPS and a calibrated image. Works well on a phone with the shared view link, where pinch zoom is supported.

The transform models are similarity (≥2 points, right for a true nadir shot), affine (≥3) and projective (≥4, corrects a slightly tilted camera).

Work is autosaved in the browser for each image. It can also be saved or loaded as a `.json` project file.

## Accounts and sharing

People can use the app without an account; everything is saved in their own browser. A free account (register → confirm email) adds **My projects**: **Share** saves the image and its project to the account and returns two links:

- a **view link** (`?p=ID`): recipients explore and query; their own changes stay in their browser and can be reverted;
- an **edit link** (`?p=ID#edit=TOKEN`): changes autosave to the server for everyone, with conflict detection. The owner can replace it with a new one at any time.

The owner can always edit their projects from any device, and can rename or delete them in My projects. Accounts support log in/out, forgot/reset password, changing name and password, and deleting the account (with its projects).

The server side is `api.php` plus `server/*.php` (PHP 8.3 with `pdo_sqlite` and `mbstring`). Data is stored outside the web root in `/var/lib/nadir` (override with the `NADIR_DATA` environment variable):

```
/var/lib/nadir/config.php          optional settings (see below)
/var/lib/nadir/nadir.sqlite        users, sessions, one-time tokens, project index, rate limits
/var/lib/nadir/projects/<id>/      meta.json, project.json, image, thumb.jpg, history/
/var/lib/nadir/osm/                OpenStreetMap cache
/var/lib/nadir/mail.log            outgoing email while no mail service is configured
```

`config.php` returns an array; every key is optional:

```php
<?php return [
    'site_url' => 'https://nadirlab.online/',          // used in email links
    'mail' => ['driver' => 'ses', 'region' => 'eu-north-1', 'key' => 'AKIA…', 'secret' => '…',
               'from' => 'Nadir Lab <no-reply@nadirlab.online>'],   // default: ['driver' => 'log']
    'quota_bytes' => 1073741824, 'quota_projects' => 100,           // per account
];
```

Admin tasks: `sudo -u www-data php server/cli.php users` and `… assign-unowned EMAIL` (gives projects shared before accounts existed to that account).

`.user.ini` raises PHP's upload limit to 60 MB for this directory (PHP-FPM).

## Deploy

Live at https://nadirlab.online/ (Apache + PHP-FPM on hetzner3). The older copy is at https://monsym.se/nadir/.

```
rsync -rt index.html api.php .user.ini css js server hetzner3:/var/www/nadirlab/
```

Built with jQuery and Bootstrap. The coordinate maths is in `js/georef.js`.
