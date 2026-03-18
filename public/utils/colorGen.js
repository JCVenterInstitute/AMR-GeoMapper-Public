class ColorGenerator {
  constructor(palette = "sunnyBeachDay", reverse = false) {
    this.palette =
      this.colorPalettes(palette) ?? this.colorPalettes("sunnyBeachDay"); // <-- string
    this.reverse = reverse;
  }
  colorPalettes(palette) {
    const palettes = {
      vibrantTones: [
        "#F94144",
        "#277DA1",
        "#F3722C",
        "#577590",
        "#F8961E",
        "#4D908E",
        "#F9844A",
        "#43AA8B",
        "#F9C74F",
        "#43AA8B",
        "#90BE6D",
      ],
      sunnyBeachDay: ["#264653", "#2A9D8F", "#E9C46A", "#F4A261", "#E76F51"],
      warmAutumnGlow: ["#003049", "#d62828", "#f77f00", "#fcbf49", "#eae2b7"],
      warmAutumnGlow2: ["#003049", "#fcbf49", "#d62828", "#f77f00"],

      refreshingSummerFun: [
        "#fb8500",
        "#ffb703",
        "#023047",
        "#219ebc",
        "#8ecae6",
      ],

      purpleSunset: ["#390099", "#9e0059", "#ff0054", "#ff5400", "#ffbd00"],
      oceanSunset: ["#001427", "#708d81", "#f4d58d", "#bf0603", "#8d0801"],

      warmEarthTones: ["#8c1c13", "#bf4342", "#e7d7c1", "#a78a7f", "#735751"],

      vibrantFusion: [
        "#ff0000",
        "#ff8700",
        "#ffd300",
        "#deff0a",
        "#a1ff0a",
        "#0aff99",
        "#0aefff",
        "#147df5",
        "#580aff",
        "#be0aff",
      ],
    };
    return palettes[palette];
  }

  *getBarColor() {
    const colors = this.reverse ? [...this.palette].reverse() : this.palette; // do not mutate
    let i = 0;
    while (true) yield colors[i++ % colors.length];
  }

  static createDiagonalPattern(color = "black", backgroundAlpha = 0.4) {
    // create a 10x10 px canvas for the pattern's base shape
    const shape = document.createElement("canvas");
    shape.width = 10;
    shape.height = 10;

    const c = shape.getContext("2d");

    // background: same color, but with alpha
    c.save();
    c.fillStyle = color;
    c.globalAlpha = backgroundAlpha; // 0..1
    c.fillRect(0, 0, shape.width, shape.height);
    c.restore();

    // diagonal lines in full opacity (same color)
    c.strokeStyle = color;
    c.lineWidth = 2;

    c.beginPath();
    c.moveTo(2, 0);
    c.lineTo(10, 8);
    c.stroke();

    c.beginPath();
    c.moveTo(0, 8);
    c.lineTo(2, 10);
    c.stroke();

    // create and return the repeatable pattern
    return c.createPattern(shape, "repeat");
  }
}

export { ColorGenerator };
