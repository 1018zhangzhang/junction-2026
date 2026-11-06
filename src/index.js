"use strict";

const { applicationDataDirectory } = require("./application-data");
const { App, AppLifecycle, Window, WindowProperty } = require("@irisview/osx/os");
const { Board, Color, Font, FusionRoot, Text, TextAlign } = require("@irisview/osx/fusionui");

const retained = {};

function start() {
  if (retained.window) return;
  retained.dataDirectory = applicationDataDirectory();
  const property = WindowProperty.create();
  property.setTitle("My First App");
  property.setSize([0.64, 0.48, 0.01]);
  retained.window = Window.create(property);
  retained.root = FusionRoot.acquireFusionRootFromWindow(retained.window);
  retained.board = Board.create();
  retained.board.setParent(retained.root.getRootWidget());
  retained.board.setIgnoreLayout(true);
  retained.board.setSize([640, 480, 0]);
  retained.board.getLocalStyle().setBackgroundColor(Color.fromRGB8(0, 0, 0));
  const text = Text.create();
  text.setParent(retained.board);
  text.setSize([640, 480, 0]);
  text.setText("今天必须处理 · 1 项");
  text.getLocalStyle().setTextColor(Color.fromRGB8(0, 255, 0));
  text.getLocalStyle().setTextFont(Font.getCachedFont("", 28, 0, 0));
  text.getLocalStyle().setTextAlign(TextAlign.CENTER);
  console.log("IrisView application ready: example.myfirstapp");
}

App.createApp((lifecycle) => {
  if (lifecycle === AppLifecycle.ON_CREATE) start();
  if (lifecycle === AppLifecycle.ON_DESTROY) {
    retained.board = undefined;
    retained.root = undefined;
    retained.window = undefined;
    retained.dataDirectory = undefined;
  }
});
