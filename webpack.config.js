const path = require("path");
module.exports = {
  mode: "development",
  entry: "./curriculum/index.html",
  devServer: {
    static: {
      directory: path.join(__dirname, "curriculum"),
    },
    port: 8085,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
      "Access-Control-Allow-Headers": "X-Requested-With, content-type, Authorization"
    }
  },
  module: {
    rules: [
      {
        test: /\.html$/i,
        loader: "html-loader",
      },
    ],
  },
};
