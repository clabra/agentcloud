import logging
from typing import List, Optional, Tuple, Type, Any
from uuid import uuid4
import json
from datetime import datetime

from langchain.tools import tool
from langchain_core.tools import BaseTool
from socketio import SimpleClient

from messaging.send_message_to_socket import send
from models.sockets import SocketEvents, SocketMessage, Message
from pydantic import BaseModel, Field
from abc import ABC, abstractmethod
from models.mongo import Tool, Datasource, Model


class HumanInputParams(BaseModel):
    text: Optional[str] = Field(description="The text message content to be sent to the client.", default=None, )


class CustomHumanInput(BaseTool):
    """A class designed to facilitate communication between a server and a client
    over a socket connection for sending human input messages and receiving feedback.

    This class initializes with a socket client and a session identifier to manage messages
    for a specific connection session."""
    name = "human_input"
    description = """Sends input to the user. The parameter of the input is called "text". It then waits for the human to respond. It returns the human response."""
    args_schema: Type[BaseModel] = HumanInputParams
    session_id: str = None
    socket_client: SimpleClient = None

    def __init__(self, socket_client: SimpleClient, session_id: str, **kwargs: Any):
        super().__init__(**kwargs)
        self.session_id = session_id
        self.socket_client = socket_client

    @staticmethod
    def extract_message(text):
        try:
            if isinstance(text, str) and text.startswith('{'):
                text_json = json.loads(text)
                if len(text_json) > 1:
                    return text # not a single key object
                return next((value for value in text_json.values() if value is not None),
                    None)  # get the first key, which is usually "question" or "message"
            return text
        except Exception as e:
            logging.exception(e)
            return text

    def _run(
            self,
            text: Optional[str]
    ) -> str:
        """
        Sends a text input to a client through the socket connection managed by this instance
        and waits for feedback.

        Parameters:

            text (str): The text message content to be sent to the client.

        Returns:
            str: Feedback received from the client as a string. Returns "exit" if a timeout
                error occurs during the process.

        Raises:
            TimeoutError: Triggered if there's a timeout while awaiting a response from
                the client. An error message is emitted to the client before the method returns "exit".

        This method constructs and sends a structured message based on the provided parameters,
        handling any potential timeouts by notifying the client of an error.
        """
        try:
            send(
                self.socket_client,
                SocketEvents.MESSAGE,
                SocketMessage(
                    room=self.session_id,
                    authorName="system",
                    message=Message(
                        chunkId=str(uuid4()),
                        text=CustomHumanInput.extract_message(text),
                        first=True,
                        tokens=1,  # Assumes 1 token is a constant value for message segmentation.
                        timestamp=datetime.now().timestamp() * 1000,
                        single=True,
                    ),
                    isFeedback=True,
                ),
                "both"
            )
            feedback = self.socket_client.receive()
            if feedback[0] == "terminate":
                return " TERMINATE ALL TASKS IMMEDIATELY "
            else:
                return feedback[1]
        except TimeoutError:
            self.socket_client.emit(
                "message",
                {
                    "room": self.session_id,
                    "type": "error",
                    "message": "TimeOutError"},
            )
            return "exit"


class GlobalBaseTool(BaseTool, ABC):

    @classmethod
    @abstractmethod
    def factory(cls, tool: Tool, datasources: List[Datasource], models: List[Tuple[Any, Model]], **kwargs) -> BaseTool:
        """ 
            cls: class type instance - tells you what class was is calling this class-level method
            tool: tool model. Need to copy or extract mandatory BaseTool fields such as name, description, args_schema
            datasources: datasource mongo object. Used to instantiate datasources such as Vector DB
            models: list of Tuple (model object such as OpenAI or FastEmbed, Model mongo object)
            kwargs: other arguments. future proofing method for when we need to pass other mongo model data or app/team configuration to the tool
        """
        pass


class get_papers_from_arxiv(GlobalBaseTool):
    """
get_papers_from_arxiv
This function takes a string query as input and fetches related research papers from the arXiv repository.
The function connects to the arXiv API, submits the query, and retrieves a list of papers matching the query criteria.
The returned data includes essential details like the paper's title, authors, abstract, and arXiv ID.
    Args:
        query (str): The query to send to arxiv to search for papers with.
    """
    name: str = "get_papers_from_arxiv"
    description: str = "This function takes a string query as input and fetches related research papers from the arXiv repository. The function connects to the arXiv API, submits the query, and retrieves a list of papers matching the query criteria. The returned data includes essential details like the paper's title, authors, abstract, and arXiv ID."
    code: str
    function_name: str
    properties_dict: dict = None
    args_schema: Type = None

    @classmethod
    def factory(cls, tool: Tool, **kargs):
        return get_papers_from_arxiv(
            name=tool.name,
            description=tool.description,
            function_name=tool.data.name,
            code=tool.data.code,
            properties_dict=tool.data.parameters.properties if tool.data.parameters.properties else []
        )

    def _run(
        self,
        query: str
    ) -> str:
        try:
            import arxiv
            search = arxiv.Search(
                query=query, max_results=10, sort_by=arxiv.SortCriterion.SubmittedDate
            )
            results = []
            for result in arxiv.Client().results(search):
                results.append(result.title)
            return results
        except Exception as e:
            print(f"An error occurred: {str(e)}")
            return f"An error occurred: {str(e)}"


class openapi_request:
    @staticmethod
    @tool("Open AI request")
    def openapi_request(**kwargs):
        """Makes Open AI request"""
        try:
            import requests

            base_url = kwargs.get("__baseurl")
            endpoint = kwargs.get("__path")
            request_method = getattr(requests, kwargs.get("__method"))
            kwargs.pop("__baseurl")
            kwargs.pop("__path")
            kwargs.pop("__method")
            response = request_method(base_url + endpoint, params=kwargs)
            if response.status_code == 200:
                return response.json()
            else:
                return None
        except Exception as e:
            print(f"An error occurred: {str(e)}")


