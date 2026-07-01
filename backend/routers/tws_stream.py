from __future__ import annotations

import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from pydantic import ValidationError
from starlette.websockets import WebSocketState

from models.tws_execution_assistant import (
    TwsStreamErrorEvent,
    TwsStreamStatusEvent,
    TwsStreamSubscribeRequest,
)
from services.tws_broker_adapter import TwsBrokerAdapter

log = logging.getLogger(__name__)

router = APIRouter()


def _socket_is_open(websocket: WebSocket) -> bool:
    return (
        websocket.client_state == WebSocketState.CONNECTED
        and websocket.application_state == WebSocketState.CONNECTED
    )


@router.websocket("/execution-assistant/ws")
async def tws_stream(websocket: WebSocket) -> None:
    app = websocket.scope["app"]
    adapter: TwsBrokerAdapter = app.state.tws_adapter
    await websocket.accept()
    adapter.stream_register_socket(websocket)
    await websocket.send_json(TwsStreamStatusEvent(connected=adapter.is_connected()).model_dump())
    try:
        while True:
            try:
                raw = await websocket.receive_json()
                req = TwsStreamSubscribeRequest(**raw)
                if req.action == "subscribe":
                    await adapter.stream_subscribe(websocket, req)
                else:
                    await adapter.stream_unsubscribe(websocket, req)
            except (json.JSONDecodeError, ValidationError, ValueError) as exc:
                if _socket_is_open(websocket):
                    await websocket.send_json(TwsStreamErrorEvent(message=str(exc)).model_dump())
            except RuntimeError as exc:
                log.debug("TWS stream receive loop stopped: %s", exc)
                break
    except WebSocketDisconnect:
        pass
    finally:
        adapter.stream_cleanup(websocket)
