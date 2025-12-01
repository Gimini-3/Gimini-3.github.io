---
title: "[Java Concurrency] Thread.start()와 Thread 객체의 모니터 락 획득 과정"
date: 2025-09-26 20:13:00 +0900
tags:
  - java
  - Concurrency
  - monitor lock
  - thread
  - synchronized
thumbnail: ""
---

# 스레드가 스레드 객체의 모니터 락을 얻는 과정

# 글을 읽기 전 알아야 할 개념

## 1. 모니터 락(Monitor Lock):

Java에서 synchronized() 키워드를 쓸 때 사용되는 잠금 메커니즘

- 자바의 모든 객체는 하나의 모니터(Monitor)를 가지고 있다.
    - HotSpot JVM은 매 객체에 실물 `ObjectMonitor`를 항상 붙여두지 않고, 필요할 때(경합 발생 등) 만든다. “모니터를 가진다”는 개념/논리적인 표현이다.
- 이 모니터는 일종의 “잠금 장치”로, 여러 스레드가 동시에 객체에 접근할 때 한 번에 하나의 스레드만 들어올 수 있도록 관리한다.
- Thread도 하나의 객체이므로 모니터 락을 가지고 있다.

### 모니터 메타데이터에 들어있는 정보

- 현재 락을 소유한 스레드(Owner)
- 재진입 횟수(한 스레드가 몇 번 중첩해서 진입했는지)
- 대기 중인 스레드 목록

# ObjectMonitor 코드

`ObjectMonitor`는 `hotspot/src/share/vm/runtime/objectMonitor.hpp` 파일에 정의되어 있습니다.

```c++
// hotspot/src/share/vm/runtime/objectMonitor.hpp

class ObjectMonitor {
  // 필드들은 실제로는 private 이지만 설명을 위해 단순화
  public:
    // 1. 객체 헤더와의 연결
    volatile markWord _header;       // 객체의 마크 워드(markWord)를 저장

    // 2. 락 소유 정보
    void* volatile _owner;           // 현재 락을 소유한 스레드의 포인터 (OSThread*)
    volatile intptr_t  _recursions;  // 재진입 횟수. _owner 스레드가 락을 중첩해서 잡은 횟수

    // 3. 스레드 대기 큐 (가장 중요)
    ObjectWaiter* volatile _EntryList; // 락을 얻기 위해 대기하는 스레드 목록 (블록된 스레드)
    ObjectWaiter* volatile _WaitSet;   // object.wait() 호출로 대기 중인 스레드 목록
};

// 스레드 대기 목록을 구성하는 노드
class ObjectWaiter {
  public:
    ObjectWaiter* _next;   // 다음 대기자를 가리키는 포인터
    ObjectWaiter* _prev;   // 이전 대기자를 가리키는 포인터
    Thread* _thread; // 대기 중인 스레드
    // ...
};
```

## 2. Thread 객체 vs 실행 단위 관계

- Thread 객체는 자바 코드 안에서 스레드를 제어하는 껍데기(핸들)이다.
- **실행 단위**는 실제로 CPU에서 동작하는 작업(명령어) 흐름이다. 운영체제 스레드(플랫폼 스레드)거나, JVM이 관리하는 가상 스레드일 수 있다.
- JVM이 둘을 연결시켜 줘야 동작할 수 있다.

  실행 단위(실행 흐름)는 CPU에서 명령어가 순차적으로 실행되는 “흐름”일 뿐이다.
  자체로는 상태를 기억하거나 이름이 붙어 있지 않고, 단지 코드를 실행하는 역할만 한다.
  개발자는 그 흐름을 중단, 재개, 이름 확인, 상태 확인 같은 제어를 하고 싶기 때문에 객체(Thread)를 만들어서 그 실행 흐름을 가리키는 핸들 역할을 시키는 것이다.

- 한 실행 단위 스레드가 만들어질 때, 무조건 대응되는 Thread 객체가 하나 생긴다.
- 즉. 1 실행 단위 ⇒ 1 Thread 객체 매핑
- 단, **Thread 객체 생성(new)**만으로는 실행 단위가 생기지 않는다. 반드시 `start()`가 호출되어야 JVM이 실행 단위를 붙여준다.

`new`로 Thread 객체를 생성한 시점에는 객체(껍데기)만 존재한다.

`start()` 가 호출되면 실행 흐름이 생성되고 객체와 1:1로 연결된다.

스레드가 종료되면 실행 흐름은 사라지고, 객체는 상태(`Terminated` 등)와 식별 정보를 간직하게 된다.

## 3. synchronized(this)

자바에서 동기화 블록을 만들 때 쓰는 키워드

- 모니터 락(monitor lock)을 얻어서 동시에 단 하나의 스레드만 코드 블록에 들어오게 보장하는 장치
- `synchronized(this)`라고 했을 때, 락은 **현재 인스턴스의 모니터**에 걸린다.
- 락은 특정 객체 단위로 존재한다. `synchronized(obj)`라고 쓰면, 스레드가  `obj(여기서는 Thread 객체)`에 달린 모니터를 얻어야만 블록 안으로 들어올 수 있다.

# Thread.start() 코드

```java
//Thread.start() 내부 코드
public void start() {  
		synchronized (this) {
		    // zero status corresponds to state "NEW"   
		    if (holder.threadStatus != 0)        
		        throw new IllegalThreadStateException();   
        start0();             
    }
}

// ※ JDK 버전에 따라 구현은 조금씩 다르다.
```

# 스레드가 스레드 객체의 모니터 락을 얻는 과정

- 스레드가 synchronized(obj) 블록에 들어가려면, JVM은 내부적으로 `obj(여기서는 Thread 객체)` 의 모니터 락이 비어 있는지 확인한다.
- 비어 있으면 현재 스레드가 락을 차지하고 블록 안으로 들어간다.
- 이미 다른 스레드가 소유 중이면, 대기 상태에 들어가고 락이 해제될 때까지 기다린다.
- 락 소유 정보는 Thread 인스턴스 안에 기록되는 것이 아닌, JVM 내부 모니터 구조체(ObjectMonitor)에 기록된다.
- 그 구조체에 “현재 이 `모니터(Thread 객체 내 모니터)`를 소유한 스레드 ID”가 저장된다.

**`synchronized(this)` 블록**: 오직 한 명만 들어갈 수 있는 **'특별한 방'**

**`Thread` 객체 (`this`)**: 그 방에 들어갈 수 있는 **'단 하나의 열쇠(모니터 락)'를 가지고 있는 주체**. 이 열쇠는 객체가 생성될 때부터 부여된다.

**`Thread` 실행 흐름**: 그 방에 들어가서 일을 해야 하는 **'일꾼'**

# Thread 객체의 락이 필요한 이유

- `Thread.start()` 는 동일한 스레드 객체에 대해 여러 번 `start()` 를 호출하면 안 된다는 제약이 있다.

```java
Thread t = new Thread(...);
t.start();
t.start(); // IllegalThreadStateException 발생해야 함
```

- 이런 상황을 막으려면, 여러 스레드가 동시에 같은 `Thread` 객체의 `start()`를 호출할 수 없도록 락을 걸어야 한다.

# 주의사항

## 락이 Thread 객체 자체에 걸린다?

- `synchronized(this)`라고 했을 때, 락은 **그 Thread 객체의 모니터**에 걸린다. 이는 ‘객체 전체 접근 금지’ 가 아니라 ‘그 모니터를 기준으로 한 임계 구역 보호’만 의미한다.
- 그래서 이 코드 블록에 들어가려면 obj의 모니터 락을 먼저 획득해야 한다는 조건이 생기는 것이다.
- 실제로 막히는 건 `synchronized(this)` 블록 **안의 코드 실행**이다.
- 락이 걸려 있어도 다른 스레드가 `obj.toString(), obj.hashCode()` 같은 동기화되지 않은 메서드를 호출하거나, obj를 일반 변수로 읽어오는 건 가능하다.
- 단지 `synchronized(obj)` 로 보호된 임계 구역에는 동시에 두 개 이상의 스레드가 못 들어올 뿐이다.

## 락 소유 정보는 객체가 가지고 있나?

- 락 소유 정보는 JVM 내부의 `ObjectMonitor` 구조체에 기록된다.
